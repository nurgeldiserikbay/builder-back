import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from './url-target-policy.js';
import { PrismaService } from '../database/prisma.service.js';

const reviewSelect = {
  id: true,
  projectId: true,
  title: true,
  mode: true,
  status: true,
  locale: true,
  sourceSnapshotId: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  private storageConfig() {
    const bucket = process.env.DESIGN_ASSETS_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('DESIGN_ASSET_STORAGE_NOT_CONFIGURED');
    const endpoint = process.env.DESIGN_ASSETS_ENDPOINT;
    const client = new S3Client({
      region: process.env.DESIGN_ASSETS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.DESIGN_ASSETS_PATH_STYLE === 'true',
      ...(process.env.DESIGN_ASSETS_ACCESS_KEY && process.env.DESIGN_ASSETS_SECRET_KEY ? {
        credentials: { accessKeyId: process.env.DESIGN_ASSETS_ACCESS_KEY, secretAccessKey: process.env.DESIGN_ASSETS_SECRET_KEY },
      } : {}),
    });
    return { bucket, client };
  }

  private async reviewForAsset(userId: string, reviewId: string, write = false) {
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active', ...(write ? { role: { not: 'viewer' } } : {}) } } } },
      select: { id: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    return review;
  }

  async reserveDesignUpload(userId: string, reviewId: string, input: { fileName: string; contentType: string; sizeBytes: number; sha256: string }, idempotencyKey: string) {
    await this.reviewForAsset(userId, reviewId, true);
    const allowedTypes = ['image/png', 'image/jpeg'];
    if (!allowedTypes.includes(input.contentType)) throw new UnprocessableEntityException('UNSUPPORTED_DESIGN_FILE_TYPE');
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 20 * 1024 * 1024) throw new BadRequestException('INVALID_DESIGN_FILE_SIZE');
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new BadRequestException('INVALID_DESIGN_CHECKSUM');
    const normalized = { ...input, fileName: input.fileName.trim() };
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const scope = `design-upload:${reviewId}`;
    const now = new Date();
    const prior = await this.prisma.idempotencyRecord.findUnique({ where: { userId_scope_key: { userId, scope, key: idempotencyKey } } });
    let assetId: string;
    if (prior && prior.expiresAt > now) {
      if (prior.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      assetId = prior.resourceId;
      const existing = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId, assetStatus: 'pending' } });
      if (!existing) throw new ConflictException('DESIGN_UPLOAD_RESERVATION_EXPIRED');
    } else {
      if (prior) await this.prisma.idempotencyRecord.delete({ where: { id: prior.id } });
      const created = await this.prisma.designSource.create({ data: {
        reviewRunId: reviewId, sourceType: 'upload', fileName: normalized.fileName.slice(0, 255), mimeType: input.contentType,
        sizeBytes: BigInt(input.sizeBytes), sha256: input.sha256.toLowerCase(), storageKey: `${reviewId}/${randomUUID()}`, assetStatus: 'pending',
      } });
      assetId = created.id;
      try {
        await this.prisma.idempotencyRecord.create({ data: { userId, scope, key: idempotencyKey, requestHash, resourceId: assetId, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      } catch (error) {
        if (!this.isUniqueViolation(error)) throw error;
        const raced = await this.prisma.idempotencyRecord.findUnique({ where: { userId_scope_key: { userId, scope, key: idempotencyKey } } });
        if (!raced || raced.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        assetId = raced.resourceId;
      }
    }
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId }, select: { id: true, storageKey: true, mimeType: true, sizeBytes: true } });
    if (!asset?.storageKey || !asset.mimeType || !asset.sizeBytes) throw new ConflictException('DESIGN_UPLOAD_RESERVATION_EXPIRED');
    const { bucket, client } = this.storageConfig();
    const expiresInSeconds = 600;
    const signed = await createPresignedPost(client, { Bucket: bucket, Key: asset.storageKey, Expires: expiresInSeconds,
      Fields: { 'Content-Type': asset.mimeType },
      Conditions: [['eq', '$Content-Type', asset.mimeType], ['content-length-range', Number(asset.sizeBytes), Number(asset.sizeBytes)]],
    });
    return { data: { assetId: asset.id, uploadUrl: signed.url, method: 'POST', expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(), requiredFields: signed.fields } };
  }

  async completeDesignUpload(userId: string, reviewId: string, assetId: string) {
    await this.reviewForAsset(userId, reviewId, true);
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId }, select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, sha256: true, assetStatus: true } });
    if (!asset?.storageKey || !asset.mimeType || !asset.sizeBytes) throw new NotFoundException('DESIGN_ASSET_NOT_FOUND');
    if (asset.assetStatus === 'verified') return { data: { assetId: asset.id, status: 'verified' } };
    if (asset.assetStatus !== 'pending' && asset.assetStatus !== 'scanning') throw new ConflictException('DESIGN_ASSET_NOT_PENDING');
    const { bucket, client } = this.storageConfig();
    await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'scanning' } });
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.storageKey }));
      if (Number(head.ContentLength) !== Number(asset.sizeBytes) || head.ContentType !== asset.mimeType) return await this.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_METADATA_MISMATCH');
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.storageKey }));
      if (!object.Body) throw new ServiceUnavailableException('DESIGN_ASSET_READ_FAILED');
      const parts: Buffer[] = []; let total = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > 20 * 1024 * 1024) return await this.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_TOO_LARGE');
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (total !== Number(asset.sizeBytes) || digest !== asset.sha256 || !this.hasImageSignature(bytes, asset.mimeType)) return await this.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_VALIDATION_FAILED');
      const scan = await this.scanWithClamAv(bytes);
      if (scan === 'unavailable') {
        await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'pending' } });
        throw new ServiceUnavailableException('DESIGN_ASSET_SCANNER_UNAVAILABLE');
      }
      if (scan === 'infected') return await this.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_REJECTED_BY_SCANNER');
      await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'verified' } });
      return { data: { assetId: asset.id, status: 'verified' } };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'pending' } });
      throw new ServiceUnavailableException('DESIGN_ASSET_VERIFICATION_UNAVAILABLE');
    }
  }

  private async rejectDesignAsset(client: S3Client, bucket: string, assetId: string, storageKey: string, code: string): Promise<never> {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    await this.prisma.designSource.update({ where: { id: assetId }, data: { assetStatus: 'rejected' } });
    throw new UnprocessableEntityException(code);
  }

  private hasImageSignature(bytes: Buffer, mimeType: string): boolean {
    if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }

  private async scanWithClamAv(bytes: Buffer): Promise<'clean' | 'infected' | 'unavailable'> {
    const host = process.env.CLAMAV_HOST; const port = Number(process.env.CLAMAV_PORT || '3310');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return 'unavailable';
    return new Promise((resolve) => {
      const socket = connect(port, host); let response = ''; let settled = false;
      const done = (result: 'clean' | 'infected' | 'unavailable') => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
      socket.setTimeout(10_000, () => done('unavailable'));
      socket.on('error', () => done('unavailable'));
      socket.on('data', (chunk) => { response += chunk.toString('utf8'); if (response.includes('OK')) done('clean'); else if (response.includes('FOUND')) done('infected'); else if (response.includes('ERROR')) done('unavailable'); });
      socket.on('connect', () => {
        socket.write(Buffer.from([122, 73, 78, 83, 84, 82, 69, 65, 77, 0]));
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const part = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
          const header = Buffer.alloc(4); header.writeUInt32BE(part.length); socket.write(header); socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }

  async getDesignAssetUrl(userId: string, reviewId: string, assetId: string) {
    await this.reviewForAsset(userId, reviewId);
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId, assetStatus: 'verified' }, select: { storageKey: true, fileName: true, mimeType: true } });
    if (!asset?.storageKey || !asset.mimeType) throw new NotFoundException('DESIGN_ASSET_NOT_FOUND');
    const { bucket, client } = this.storageConfig();
    const disposition = asset.mimeType.startsWith('image/') ? 'inline' : 'attachment';
    const command = new GetObjectCommand({ Bucket: bucket, Key: asset.storageKey, ResponseContentType: asset.mimeType, ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.fileName || 'design')}` });
    return { data: { url: await getSignedUrl(client, command, { expiresIn: 300 }), expiresInSeconds: 300 } };
  }

  async savePageMapping(userId: string, reviewId: string, pageId: string, input: { designAssetId: string | null; viewportWidth: number; viewportHeight: number; deviceScale: number; requirementIds: string[] }) {
    await this.reviewForAsset(userId, reviewId, true);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true, route: true, title: true, status: true } });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    if (input.designAssetId) {
      const asset = await this.prisma.designSource.findFirst({ where: { id: input.designAssetId, reviewRunId: reviewId, assetStatus: 'verified' }, select: { id: true } });
      if (!asset) throw new UnprocessableEntityException('DESIGN_ASSET_NOT_VERIFIED');
    }
    const mapping = await this.prisma.pageDesignMapping.upsert({
      where: { pageId },
      create: { pageId, designSourceId: input.designAssetId, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight, deviceScale: input.deviceScale, requirementIds: input.requirementIds, mappingAuthorUserId: userId },
      update: { designSourceId: input.designAssetId, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight, deviceScale: input.deviceScale, requirementIds: input.requirementIds, mappingAuthorUserId: userId },
      select: { designSourceId: true, viewportWidth: true, viewportHeight: true, deviceScale: true, requirementIds: true, updatedAt: true },
    });
    return { data: { id: page.id, route: page.route, label: (page.title ?? page.route).slice(0, 120), status: 'mapped', designAssetId: mapping.designSourceId, viewport: { width: mapping.viewportWidth, height: mapping.viewportHeight, deviceScale: Number(mapping.deviceScale) }, requirementIds: mapping.requirementIds, findingCount: 0, updatedAt: mapping.updatedAt } };
  }

  async create(userId: string, projectId: string, input: {
    title: string;
    mode: 'site_only' | 'site_and_design' | 'design_only';
    locale: 'en' | 'ru' | 'kk';
  }, idempotencyKey: string) {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true, status: true },
    });
    if (!membership || membership.status !== 'active') throw new NotFoundException('PROJECT_NOT_FOUND');
    if (membership.role === 'viewer') throw new ForbiddenException('REVIEW_CREATE_FORBIDDEN');

    const scope = `review:create:${projectId}`;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const now = new Date();
    const createOrReplay = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        const existingReview = await tx.reviewRun.findUnique({
          where: { id: previous.resourceId },
          select: reviewSelect,
        });
        if (existingReview) return existingReview;
      }
      if (previous) await tx.idempotencyRecord.delete({ where: { id: previous.id } });

      const review = await tx.reviewRun.create({
        data: { projectId, ownerUserId: userId, ...input },
        select: reviewSelect,
      });
      await tx.idempotencyRecord.create({
        data: {
          userId,
          scope,
          key: idempotencyKey,
          requestHash,
          resourceId: review.id,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      return review;
    });

    try {
      return { data: await createOrReplay() };
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (!previous || previous.expiresAt <= new Date()) throw error;
      if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      const existingReview = await this.prisma.reviewRun.findUnique({
        where: { id: previous.resourceId },
        select: reviewSelect,
      });
      if (!existingReview) throw error;
      return { data: existingReview };
    }
  }

  async get(userId: string, reviewId: string) {
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: {
        id: reviewId,
        project: { members: { some: { userId, status: 'active' } } },
      },
      select: reviewSelect,
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    return { data: review };
  }



  async listPages(userId: string, reviewId: string) {
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active' } } } },
      select: { id: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');

    const pages = await this.prisma.reviewPage.findMany({
      where: { reviewRunId: review.id, status: { not: 'excluded' } },
      orderBy: [{ discoveryDepth: 'asc' }, { route: 'asc' }],
      take: 100,
      select: {
        id: true,
        route: true,
        title: true,
        status: true,
        mapping: { select: { designSourceId: true, viewportWidth: true, viewportHeight: true, deviceScale: true } },
        _count: { select: { findings: true } },
      },
    });
    return {
      data: pages.map((page) => ({
        id: page.id,
        route: page.route,
        label: (page.title ?? page.route).slice(0, 120),
        status: page.mapping ? 'mapped' : page.status === 'captured' ? 'captured' : page.status === 'failed' ? 'failed' : 'discovered',
        designAssetId: page.mapping?.designSourceId ?? null,
        viewport: {
          width: page.mapping?.viewportWidth ?? 1440,
          height: page.mapping?.viewportHeight ?? 900,
          deviceScale: page.mapping ? Number(page.mapping.deviceScale) : 1,
        },
        findingCount: page._count.findings,
      })),
    };
  }

  async registerUrl(userId: string, reviewId: string, rawUrl: string, idempotencyKey: string) {
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active', role: { not: 'viewer' } } } } },
      select: { id: true, mode: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    if (review.mode === 'design_only') throw new ConflictException('REVIEW_MODE_DOES_NOT_ACCEPT_SITE_URL');

    let target: Awaited<ReturnType<typeof resolveAndValidateReviewTarget>>;
    try {
      target = await resolveAndValidateReviewTarget(rawUrl);
    } catch (error) {
      if (error instanceof ReviewTargetPolicyError) {
        throw new UnprocessableEntityException({ code: error.code });
      }
      throw error;
    }

    const persist = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.reviewJob.findUnique({
        where: { reviewRunId_idempotencyKey: { reviewRunId: review.id, idempotencyKey } },
      });
      if (previous) {
        const stored = previous.result;
        const previousUrl = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
          ? (stored as Record<string, unknown>).targetUrl
          : undefined;
        if (previousUrl !== target.url) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return previous;
      }

      await tx.reviewRun.update({
        where: { id: review.id },
        data: {
          baseOrigin: new URL(target.url).origin,
          sourceSnapshot: {
            validatedUrl: target.url,
            hostname: target.hostname,
            resolvedAddresses: target.resolvedAddresses,
            validatedAt: new Date().toISOString(),
          },
          status: 'queued',
        },
      });
      return tx.reviewJob.create({
        data: {
          reviewRunId: review.id,
          jobType: 'discover_pages',
          idempotencyKey,
          correlationId: randomUUID(),
          result: {
            targetUrl: target.url,
            hostname: target.hostname,
            resolvedAddresses: target.resolvedAddresses,
          },
        },
      });
    });

    try {
      const job = await persist();
      return { data: { jobId: job.id, status: job.status } };
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.reviewJob.findUnique({
        where: { reviewRunId_idempotencyKey: { reviewRunId: review.id, idempotencyKey } },
      });
      if (!previous) throw error;
      const stored = previous.result;
      const previousUrl = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>).targetUrl
        : undefined;
      if (previousUrl !== target.url) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      return { data: { jobId: previous.id, status: previous.status } };
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
