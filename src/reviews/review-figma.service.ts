// Figma: OAuth connection, token refresh and frame import as a design.
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { ReviewsCore } from './reviews-core.js';
import { ReviewDesignsService } from './review-designs.service.js';

@Injectable()
export class ReviewFigmaService {
  private readonly figmaRefreshes = new Map<string, Promise<string>>();

  constructor(private readonly prisma: PrismaService, private readonly core: ReviewsCore, private readonly designs: ReviewDesignsService) {}

  figmaConfig() {
    const clientId = process.env.FIGMA_CLIENT_ID;
    const clientSecret = process.env.FIGMA_CLIENT_SECRET;
    const redirectUri = process.env.FIGMA_REDIRECT_URI;
    const encryptionKey = process.env.FIGMA_TOKEN_ENCRYPTION_KEY;
    if (!clientId || !clientSecret || !redirectUri || !encryptionKey) {
      throw new ServiceUnavailableException('FIGMA_INTEGRATION_NOT_CONFIGURED');
    }
    let callback: URL;
    try { callback = new URL(redirectUri); } catch { throw new ServiceUnavailableException('FIGMA_INTEGRATION_NOT_CONFIGURED'); }
    if (callback.protocol !== 'https:' && callback.hostname !== 'localhost') {
      throw new ServiceUnavailableException('FIGMA_INTEGRATION_NOT_CONFIGURED');
    }
    const key = Buffer.from(encryptionKey, 'base64');
    if (key.length !== 32) throw new ServiceUnavailableException('FIGMA_INTEGRATION_NOT_CONFIGURED');
    return { clientId, clientSecret, redirectUri, key };
  }

  encryptFigmaToken(token: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  decryptFigmaToken(payload: string, key: Buffer): string {
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) throw new ServiceUnavailableException('FIGMA_RECONNECT_REQUIRED');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('FIGMA_RECONNECT_REQUIRED');
    }
  }

  async getUsableFigmaAccessToken(userId: string): Promise<string> {
    const connection = await this.prisma.figmaConnection.findUnique({
      where: { userId },
      select: { accessTokenEncrypted: true, refreshTokenEncrypted: true, accessTokenExpiresAt: true },
    });
    if (!connection) throw new ConflictException('FIGMA_NOT_CONNECTED');
    const config = this.figmaConfig();
    if (connection.accessTokenExpiresAt.getTime() > Date.now() + 30_000) {
      return this.decryptFigmaToken(connection.accessTokenEncrypted, config.key);
    }

    const pending = this.figmaRefreshes.get(userId);
    if (pending) return pending;
    const refresh = this.refreshFigmaAccessToken(userId, connection, config);
    this.figmaRefreshes.set(userId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.figmaRefreshes.get(userId) === refresh) this.figmaRefreshes.delete(userId);
    }
  }

  async refreshFigmaAccessToken(
    userId: string,
    previous: { accessTokenEncrypted: string; refreshTokenEncrypted: string; accessTokenExpiresAt: Date },
    config: ReturnType<ReviewFigmaService['figmaConfig']>,
  ): Promise<string> {
    let refreshToken: string;
    try {
      refreshToken = this.decryptFigmaToken(previous.refreshTokenEncrypted, config.key);
    } catch {
      throw new ConflictException('FIGMA_RECONNECT_REQUIRED');
    }

    let response: Response;
    try {
      response = await fetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ServiceUnavailableException('FIGMA_TOKEN_REFRESH_UNAVAILABLE');
    }

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new ServiceUnavailableException('FIGMA_TOKEN_REFRESH_UNAVAILABLE');
      }
      throw new ConflictException('FIGMA_RECONNECT_REQUIRED');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceUnavailableException('FIGMA_TOKEN_REFRESH_UNAVAILABLE');
    }
    const tokens = body as Record<string, unknown>;
    const accessToken = tokens.access_token;
    const expiresIn = tokens.expires_in;
    if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number'
      || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 31_536_000) {
      throw new ServiceUnavailableException('FIGMA_TOKEN_REFRESH_UNAVAILABLE');
    }
    const newRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
      ? tokens.refresh_token
      : refreshToken;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const updated = await this.prisma.figmaConnection.updateMany({
      where: { userId, accessTokenEncrypted: previous.accessTokenEncrypted },
      data: {
        accessTokenEncrypted: this.encryptFigmaToken(accessToken, config.key),
        refreshTokenEncrypted: this.encryptFigmaToken(newRefreshToken, config.key),
        accessTokenExpiresAt: expiresAt,
      },
    });
    if (updated.count === 1) return accessToken;

    // Another API instance refreshed this connection while this request was in flight.
    const current = await this.prisma.figmaConnection.findUnique({
      where: { userId },
      select: { accessTokenEncrypted: true, accessTokenExpiresAt: true },
    });
    if (!current) throw new ConflictException('FIGMA_NOT_CONNECTED');
    if (current.accessTokenExpiresAt.getTime() <= Date.now() + 30_000) {
      throw new ServiceUnavailableException('FIGMA_TOKEN_REFRESH_UNAVAILABLE');
    }
    return this.decryptFigmaToken(current.accessTokenEncrypted, config.key);
  }

  async startFigmaConnection(userId: string) {
    const config = this.figmaConfig();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    await this.prisma.figmaOAuthState.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
    await this.prisma.figmaOAuthState.create({
      data: {
        userId,
        stateHash: createHash('sha256').update(state).digest('hex'),
        codeVerifier,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const authorizeUrl = new URL('https://www.figma.com/oauth');
    authorizeUrl.searchParams.set('client_id', config.clientId);
    authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizeUrl.searchParams.set('scope', 'file_content:read');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    return { data: { authorizationUrl: authorizeUrl.toString() } };
  }

  async completeFigmaConnection(userId: string, code: string, state: string) {
    const config = this.figmaConfig();
    const stateHash = createHash('sha256').update(state).digest('hex');
    const oauthState = await this.prisma.figmaOAuthState.findFirst({
      where: { userId, stateHash, expiresAt: { gt: new Date() } },
      select: { id: true, codeVerifier: true },
    });
    if (!oauthState) throw new ConflictException('FIGMA_OAUTH_STATE_INVALID');
    const consumed = await this.prisma.figmaOAuthState.deleteMany({ where: { id: oauthState.id } });
    if (consumed.count !== 1) throw new ConflictException('FIGMA_OAUTH_STATE_INVALID');

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          redirect_uri: config.redirectUri,
          code,
          grant_type: 'authorization_code',
          code_verifier: oauthState.codeVerifier,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ServiceUnavailableException('FIGMA_TOKEN_EXCHANGE_UNAVAILABLE');
    }
    if (!tokenResponse.ok) throw new UnprocessableEntityException('FIGMA_AUTHORIZATION_FAILED');
    const tokenBody: unknown = await tokenResponse.json().catch(() => null);
    if (!tokenBody || typeof tokenBody !== 'object' || Array.isArray(tokenBody)) {
      throw new UnprocessableEntityException('FIGMA_AUTHORIZATION_FAILED');
    }
    const tokens = tokenBody as Record<string, unknown>;
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string'
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 31_536_000) {
      throw new UnprocessableEntityException('FIGMA_AUTHORIZATION_FAILED');
    }
    const figmaUserId = typeof tokens.user_id_string === 'string' ? tokens.user_id_string.slice(0, 128) : null;
    await this.prisma.figmaConnection.upsert({
      where: { userId },
      create: {
        userId,
        figmaUserId,
        accessTokenEncrypted: this.encryptFigmaToken(accessToken, config.key),
        refreshTokenEncrypted: this.encryptFigmaToken(refreshToken, config.key),
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        scopes: ['file_content:read'],
      },
      update: {
        figmaUserId,
        accessTokenEncrypted: this.encryptFigmaToken(accessToken, config.key),
        refreshTokenEncrypted: this.encryptFigmaToken(refreshToken, config.key),
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        scopes: ['file_content:read'],
      },
    });
    return { data: { connected: true } };
  }

  async getFigmaConnectionStatus(userId: string) {
    const connection = await this.prisma.figmaConnection.findUnique({
      where: { userId },
      select: { figmaUserId: true, accessTokenExpiresAt: true, connectedAt: true },
    });
    return { data: {
      connected: Boolean(connection),
      figmaUserId: connection?.figmaUserId ?? null,
      expiresAt: connection?.accessTokenExpiresAt ?? null,
      connectedAt: connection?.connectedAt ?? null,
    } };
  }

  async disconnectFigma(userId: string) {
    await this.prisma.figmaConnection.deleteMany({ where: { userId } });
    await this.prisma.figmaOAuthState.deleteMany({ where: { userId } });
    return { data: { connected: false } };
  }

  parseFigmaFrameUrl(rawUrl: string): { fileKey: string; nodeId: string } {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new BadRequestException('INVALID_FIGMA_URL'); }
    if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname)) {
      throw new BadRequestException('INVALID_FIGMA_URL');
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (!['design', 'file', 'proto'].includes(segments[0] ?? '') || !segments[1] || !/^[A-Za-z0-9_-]{8,128}$/.test(segments[1])) {
      throw new BadRequestException('INVALID_FIGMA_URL');
    }
    const rawNodeId = url.searchParams.get('node-id') ?? url.searchParams.get('node_id');
    if (!rawNodeId || rawNodeId.length > 64) throw new BadRequestException('FIGMA_FRAME_ID_REQUIRED');
    const nodeId = rawNodeId.replace('-', ':');
    if (!/^\d+:\d+$/.test(nodeId)) throw new BadRequestException('INVALID_FIGMA_FRAME_ID');
    return { fileKey: segments[1], nodeId };
  }

  async importFigmaFrame(userId: string, reviewId: string, input: {
    pageId: string; figmaUrl: string; viewportWidth: number; viewportHeight: number; deviceScale: number;
  }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const { fileKey, nodeId } = this.parseFigmaFrameUrl(input.figmaUrl);
    const page = await this.prisma.reviewPage.findFirst({
      where: { id: input.pageId, reviewRunId: reviewId, status: { not: 'excluded' } },
      select: { id: true, mapping: { select: { requirementIds: true } } },
    });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');

    const existing = await this.prisma.designSource.findFirst({
      where: { reviewRunId: reviewId, sourceType: 'figma', figmaFileKey: fileKey, figmaNodeId: nodeId, assetStatus: 'verified' },
      select: { id: true },
    });
    if (existing) {
      await this.designs.savePageMapping(userId, reviewId, page.id, {
        designAssetId: existing.id, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight,
        deviceScale: input.deviceScale, requirementIds: page.mapping?.requirementIds ?? [],
      });
      return { data: { assetId: existing.id, status: 'verified', fileKey, nodeId } };
    }

    const accessToken = await this.getUsableFigmaAccessToken(userId);

    let exportResponse: Response;
    try {
      exportResponse = await fetch(`https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1`, {
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new ServiceUnavailableException('FIGMA_EXPORT_UNAVAILABLE');
    }
    if (exportResponse.status === 401 || exportResponse.status === 403) throw new ConflictException('FIGMA_RECONNECT_REQUIRED');
    if (exportResponse.status === 404) throw new UnprocessableEntityException('FIGMA_FILE_NOT_ACCESSIBLE');
    if (exportResponse.status === 429 || exportResponse.status >= 500) throw new ServiceUnavailableException('FIGMA_EXPORT_UNAVAILABLE');
    if (!exportResponse.ok) throw new UnprocessableEntityException('FIGMA_FRAME_EXPORT_FAILED');
    const exportBody: unknown = await exportResponse.json().catch(() => null);
    const imageUrl = exportBody && typeof exportBody === 'object' && !Array.isArray(exportBody)
      ? (exportBody as { images?: Record<string, unknown> }).images?.[nodeId]
      : null;
    if (typeof imageUrl !== 'string') throw new UnprocessableEntityException('FIGMA_FRAME_EXPORT_FAILED');

    let renderedUrl: URL;
    try { renderedUrl = new URL(imageUrl); } catch { throw new UnprocessableEntityException('FIGMA_FRAME_EXPORT_FAILED'); }
    const host = renderedUrl.hostname.toLowerCase();
    if (renderedUrl.protocol !== 'https:' || renderedUrl.username || renderedUrl.password
      || !(host === 'figma.com' || host.endsWith('.figma.com') || host.endsWith('.amazonaws.com'))) {
      throw new UnprocessableEntityException('FIGMA_FRAME_EXPORT_FAILED');
    }
    let imageResponse: Response;
    try {
      imageResponse = await fetch(renderedUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ServiceUnavailableException('FIGMA_IMAGE_DOWNLOAD_UNAVAILABLE');
    }
    if (!imageResponse.ok) throw new ServiceUnavailableException('FIGMA_IMAGE_DOWNLOAD_UNAVAILABLE');
    const declaredLength = Number(imageResponse.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 20 * 1024 * 1024) throw new UnprocessableEntityException('FIGMA_IMAGE_TOO_LARGE');
    if (!imageResponse.body) throw new ServiceUnavailableException('FIGMA_IMAGE_DOWNLOAD_UNAVAILABLE');
    const reader = imageResponse.body.getReader();
    const imageParts: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = Buffer.from(value);
        totalBytes += part.length;
        if (totalBytes > 20 * 1024 * 1024) {
          await reader.cancel();
          throw new UnprocessableEntityException('FIGMA_IMAGE_TOO_LARGE');
        }
        imageParts.push(part);
      }
    } finally {
      reader.releaseLock();
    }
    const imageBytes = Buffer.concat(imageParts);
    if (imageBytes.length < 8 || !imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new UnprocessableEntityException('FIGMA_IMAGE_INVALID');
    }

    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const storageKey = `${reviewId}/figma/${randomUUID()}.png`;
    const { bucket, client } = this.core.storageConfig();
    let source: { id: string } | undefined;
    try {
      source = await this.prisma.designSource.create({
        data: {
          reviewRunId: reviewId, sourceType: 'figma', fileName: `figma-${fileKey}-${nodeId.replace(':', '-')}.png`,
          mimeType: 'image/png', sizeBytes: BigInt(imageBytes.length), sha256, storageKey, assetStatus: 'pending',
          figmaFileKey: fileKey, figmaNodeId: nodeId,
        },
        select: { id: true },
      });
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: storageKey, Body: imageBytes, ContentType: 'image/png',
        Metadata: { sha256, source: 'figma-import' },
      }));
    } catch (error) {
      if (source) {
        await this.prisma.designSource.deleteMany({ where: { id: source.id, assetStatus: 'pending' } }).catch(() => undefined);
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey })).catch(() => undefined);
      await client.destroy();
      throw error;
    }
    await client.destroy();

    try {
      await this.designs.completeDesignUpload(userId, reviewId, source.id);
    } catch (error) {
      const asset = await this.prisma.designSource.findUnique({
        where: { id: source.id },
        select: { assetStatus: true },
      }).catch(() => null);
      if (asset?.assetStatus === 'pending' || asset?.assetStatus === 'scanning') {
        await this.prisma.designSource.deleteMany({
          where: { id: source.id, assetStatus: { in: ['pending', 'scanning'] } },
        }).catch(() => undefined);
        const cleanup = this.core.storageConfig();
        await cleanup.client.send(new DeleteObjectCommand({ Bucket: cleanup.bucket, Key: storageKey })).catch(() => undefined);
        await cleanup.client.destroy();
      }
      throw error;
    }

    await this.designs.savePageMapping(userId, reviewId, page.id, {
      designAssetId: source.id, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight,
      deviceScale: input.deviceScale, requirementIds: page.mapping?.requirementIds ?? [],
    });
    return { data: { assetId: source.id, status: 'verified', fileKey, nodeId } };
  }
}
