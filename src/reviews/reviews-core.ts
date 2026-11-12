// Site check basics: storage, access to a review for assets, image checks and malware scan.
import { Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { connect } from 'node:net';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class ReviewsCore {
  constructor(private readonly prisma: PrismaService) {}

  storageConfig() {
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

  async reviewForAsset(userId: string, reviewId: string, write = false) {
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active', ...(write ? { role: { not: 'viewer' } } : {}) } } } },
      select: { id: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    return review;
  }

  async rejectDesignAsset(client: S3Client, bucket: string, assetId: string, storageKey: string, code: string): Promise<never> {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    await this.prisma.designSource.update({ where: { id: assetId }, data: { assetStatus: 'rejected' } });
    throw new UnprocessableEntityException(code);
  }

  hasImageSignature(bytes: Buffer, mimeType: string): boolean {
    if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }

  async scanWithClamAv(bytes: Buffer): Promise<'clean' | 'infected' | 'unavailable'> {
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

  isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
