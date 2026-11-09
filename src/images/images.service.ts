import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { contentImageIds } from '../journey/artifacts.js';
import { scanRequired, scanWithClamAv } from '../security/clamav.js';
import { ImageRejectedError, MAX_UPLOAD_BYTES, detectImageType, processImage } from './image-processing.js';

export const MAX_IMAGES_PER_PROJECT = 30;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanAlt(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestException('IMAGE_ALT_INVALID');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > 200) throw new BadRequestException('IMAGE_ALT_TOO_LONG');
  return text;
}

const listFields = { id: true, width: true, height: true, sizeBytes: true, alt: true, createdAt: true } as const;

@Injectable()
export class ImagesService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService) {}

  async list(userId: string, projectId: string) {
    await this.journey.assertImageAccess(userId, projectId, 'read');
    const [items, used] = await Promise.all([
      this.prisma.projectImage.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: listFields }),
      this.usedIds(projectId),
    ]);
    return { data: { items: items.map((item) => ({ ...item, inUse: used.has(item.id) })), limit: MAX_IMAGES_PER_PROJECT } };
  }

  async upload(userId: string, projectId: string, file: { buffer: Buffer; size: number } | undefined, alt: unknown) {
    await this.journey.assertImageAccess(userId, projectId, 'write');
    if (!file || !file.buffer?.length) throw new BadRequestException('IMAGE_FILE_REQUIRED');
    if (file.size > MAX_UPLOAD_BYTES) throw new UnprocessableEntityException('IMAGE_TOO_LARGE');
    const description = cleanAlt(alt);
    if (!detectImageType(file.buffer)) throw new UnprocessableEntityException('IMAGE_TYPE_NOT_SUPPORTED');
    const count = await this.prisma.projectImage.count({ where: { projectId } });
    if (count >= MAX_IMAGES_PER_PROJECT) throw new ConflictException('IMAGE_LIMIT_REACHED');
    // Uploaded bytes are untrusted: scan the original first (fail closed), then decode and re-encode, which drops metadata and anything that is not pixels.
    if (scanRequired()) {
      const scan = await scanWithClamAv(file.buffer);
      if (scan === 'infected') throw new UnprocessableEntityException('IMAGE_REJECTED_BY_SCAN');
      if (scan === 'unavailable') throw new ServiceUnavailableException('IMAGE_SCAN_UNAVAILABLE');
    }
    let processed;
    try { processed = await processImage(file.buffer); } catch (error) {
      if (error instanceof ImageRejectedError) throw new UnprocessableEntityException(error.code);
      throw new UnprocessableEntityException('IMAGE_UNREADABLE');
    }
    const image = await this.prisma.projectImage.create({
      data: { projectId, data: new Uint8Array(processed.data), width: processed.width, height: processed.height, sizeBytes: processed.data.length, sha256: processed.sha256, alt: description, createdByUserId: userId },
      select: listFields,
    });
    return { data: { ...image, inUse: false } };
  }

  async file(userId: string, projectId: string, imageId: string) {
    await this.journey.assertImageAccess(userId, projectId, 'read');
    if (!uuid.test(imageId)) throw new NotFoundException('IMAGE_NOT_FOUND');
    const image = await this.prisma.projectImage.findFirst({ where: { id: imageId, projectId }, select: { data: true, sha256: true } });
    if (!image) throw new NotFoundException('IMAGE_NOT_FOUND');
    return { data: Buffer.from(image.data), etag: image.sha256 };
  }

  async setAlt(userId: string, projectId: string, imageId: string, alt: unknown) {
    await this.journey.assertImageAccess(userId, projectId, 'write');
    if (!uuid.test(imageId)) throw new NotFoundException('IMAGE_NOT_FOUND');
    const updated = await this.prisma.projectImage.updateMany({ where: { id: imageId, projectId }, data: { alt: cleanAlt(alt) } });
    if (!updated.count) throw new NotFoundException('IMAGE_NOT_FOUND');
    return this.list(userId, projectId);
  }

  async remove(userId: string, projectId: string, imageId: string) {
    await this.journey.assertImageAccess(userId, projectId, 'write');
    if (!uuid.test(imageId)) throw new NotFoundException('IMAGE_NOT_FOUND');
    if ((await this.usedIds(projectId)).has(imageId)) throw new ConflictException('IMAGE_IN_USE');
    const deleted = await this.prisma.projectImage.deleteMany({ where: { id: imageId, projectId } });
    if (!deleted.count) throw new NotFoundException('IMAGE_NOT_FOUND');
    return this.list(userId, projectId);
  }

  /** Photos referenced by the current draft or the accepted version of the texts stage. */
  private async usedIds(projectId: string): Promise<Set<string>> {
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'content' }, select: { currentVersionId: true, approvedVersionId: true } });
    const ids = [stage?.currentVersionId, stage?.approvedVersionId].filter((id): id is string => Boolean(id));
    if (!ids.length) return new Set();
    const versions = await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: ids } }, select: { content: true } });
    return new Set(versions.flatMap((version) => contentImageIds(version.content)));
  }
}
