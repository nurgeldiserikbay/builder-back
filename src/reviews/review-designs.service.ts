// Design uploads per page and the page ↔ design mapping.
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { ReviewsCore } from './reviews-core.js';

@Injectable()
export class ReviewDesignsService {
  constructor(private readonly prisma: PrismaService, private readonly core: ReviewsCore) {}

  async reserveDesignUpload(userId: string, reviewId: string, input: { fileName: string; contentType: string; sizeBytes: number; sha256: string }, idempotencyKey: string) {
    await this.core.reviewForAsset(userId, reviewId, true);
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
        if (!this.core.isUniqueViolation(error)) throw error;
        const raced = await this.prisma.idempotencyRecord.findUnique({ where: { userId_scope_key: { userId, scope, key: idempotencyKey } } });
        if (!raced || raced.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        assetId = raced.resourceId;
      }
    }
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId }, select: { id: true, storageKey: true, mimeType: true, sizeBytes: true } });
    if (!asset?.storageKey || !asset.mimeType || !asset.sizeBytes) throw new ConflictException('DESIGN_UPLOAD_RESERVATION_EXPIRED');
    const { bucket, client } = this.core.storageConfig();
    const expiresInSeconds = 600;
    const signed = await createPresignedPost(client, { Bucket: bucket, Key: asset.storageKey, Expires: expiresInSeconds,
      Fields: { 'Content-Type': asset.mimeType },
      Conditions: [['eq', '$Content-Type', asset.mimeType], ['content-length-range', Number(asset.sizeBytes), Number(asset.sizeBytes)]],
    });
    return { data: { assetId: asset.id, uploadUrl: signed.url, method: 'POST', expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(), requiredFields: signed.fields } };
  }

  async completeDesignUpload(userId: string, reviewId: string, assetId: string) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId }, select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, sha256: true, assetStatus: true } });
    if (!asset?.storageKey || !asset.mimeType || !asset.sizeBytes) throw new NotFoundException('DESIGN_ASSET_NOT_FOUND');
    if (asset.assetStatus === 'verified') return { data: { assetId: asset.id, status: 'verified' } };
    if (asset.assetStatus !== 'pending' && asset.assetStatus !== 'scanning') throw new ConflictException('DESIGN_ASSET_NOT_PENDING');
    const { bucket, client } = this.core.storageConfig();
    await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'scanning' } });
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.storageKey }));
      if (Number(head.ContentLength) !== Number(asset.sizeBytes) || head.ContentType !== asset.mimeType) return await this.core.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_METADATA_MISMATCH');
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.storageKey }));
      if (!object.Body) throw new ServiceUnavailableException('DESIGN_ASSET_READ_FAILED');
      const parts: Buffer[] = []; let total = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > 20 * 1024 * 1024) return await this.core.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_TOO_LARGE');
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (total !== Number(asset.sizeBytes) || digest !== asset.sha256 || !this.core.hasImageSignature(bytes, asset.mimeType)) return await this.core.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_VALIDATION_FAILED');
      const scan = await this.core.scanWithClamAv(bytes);
      if (scan === 'unavailable') {
        await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'pending' } });
        throw new ServiceUnavailableException('DESIGN_ASSET_SCANNER_UNAVAILABLE');
      }
      if (scan === 'infected') return await this.core.rejectDesignAsset(client, bucket, asset.id, asset.storageKey, 'DESIGN_ASSET_REJECTED_BY_SCANNER');
      await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'verified' } });
      return { data: { assetId: asset.id, status: 'verified' } };
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof UnprocessableEntityException) throw error;
      await this.prisma.designSource.update({ where: { id: asset.id }, data: { assetStatus: 'pending' } });
      throw new ServiceUnavailableException('DESIGN_ASSET_VERIFICATION_UNAVAILABLE');
    }
  }

  async getDesignAssetUrl(userId: string, reviewId: string, assetId: string) {
    await this.core.reviewForAsset(userId, reviewId);
    const asset = await this.prisma.designSource.findFirst({ where: { id: assetId, reviewRunId: reviewId, assetStatus: 'verified' }, select: { storageKey: true, fileName: true, mimeType: true } });
    if (!asset?.storageKey || !asset.mimeType) throw new NotFoundException('DESIGN_ASSET_NOT_FOUND');
    const { bucket, client } = this.core.storageConfig();
    const disposition = asset.mimeType.startsWith('image/') ? 'inline' : 'attachment';
    const command = new GetObjectCommand({ Bucket: bucket, Key: asset.storageKey, ResponseContentType: asset.mimeType, ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(asset.fileName || 'design')}` });
    return { data: { url: await getSignedUrl(client, command, { expiresIn: 300 }), expiresInSeconds: 300 } };
  }

  async savePageMapping(userId: string, reviewId: string, pageId: string, input: { designAssetId: string | null; viewportWidth: number; viewportHeight: number; deviceScale: number; requirementIds: string[] }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true, route: true, title: true, status: true, _count: { select: { findings: true } } } });
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
    return { data: { id: page.id, route: page.route, label: (page.title ?? page.route).slice(0, 120), status: 'mapped', designAssetId: mapping.designSourceId, viewport: { width: mapping.viewportWidth, height: mapping.viewportHeight, deviceScale: Number(mapping.deviceScale) }, findingCount: page._count.findings } };
  }
}
