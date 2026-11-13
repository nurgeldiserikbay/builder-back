import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { acceptRoles, editableProject, isUuid, JourneyCore, writeRoles } from '../journey/journey-core.js';
import { scanRequired, scanWithClamAv } from '../security/clamav.js';
import { RateLimiter } from '../security/rate-limit.js';
import { cleanFileName, detectStageFile, STAGE_FILE_LIMITS } from './file-types.js';

const listFields = { id: true, name: true, kind: true, mime: true, sizeBytes: true, sha256: true, note: true, createdByUserId: true, createdAt: true } as const;

function cleanNote(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestException('FILE_NOTE_INVALID');
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  if (text.length > STAGE_FILE_LIMITS.note) throw new BadRequestException('FILE_NOTE_TOO_LONG');
  return text;
}

/**
 * Files attached to a stage for people to read: briefs, photos of sketches, price lists, an archive of the current site.
 * They are private to people who see the stage, scanned before they are stored (fail closed) and kept as uploaded:
 * a new upload never replaces an older file. They are not passed to an AI provider and are not used to build anything;
 * a ZIP archive can be analysed read-only on request (AnalysisService).
 */
@Injectable()
export class StageFilesService {
  readonly limits = new RateLimiter();
  static readonly uploadsPerUser = { max: 30, windowMs: 60 * 60_000 };

  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  async list(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const rows = await this.prisma.stageFile.findMany({ where: { stageId: stage.id }, orderBy: { createdAt: 'desc' }, select: listFields });
    const people = await this.core.historyPeople(ctx, projectId, userId);
    const managing = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const canUpload = this.core.canWrite(ctx, key) && editableProject(ctx.project.status);
    return {
      data: {
        files: rows.map((row) => ({
          id: row.id, name: row.name, kind: row.kind, mime: row.mime, sizeBytes: row.sizeBytes, sha256: row.sha256, note: row.note, createdAt: row.createdAt,
          author: people.get(row.createdByUserId)?.name ?? tr('Участник'), mine: row.createdByUserId === userId,
          canDelete: canUpload && (managing || row.createdByUserId === userId), canAnalyze: row.kind === 'zip' && ctx.viewer.kind === 'member' && ctx.role !== 'viewer',
        })),
        canUpload, limits: { fileBytes: STAGE_FILE_LIMITS.fileBytes, perStage: STAGE_FILE_LIMITS.perStage, note: STAGE_FILE_LIMITS.note },
        accepted: ['pdf', 'png', 'jpg', 'webp', 'txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'zip'],
      },
    };
  }

  async upload(userId: string, projectId: string, key: string, file: { buffer: Buffer; size: number; originalname?: string } | undefined, body: Record<string, unknown> | undefined) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const created = await this.store(userId, projectId, { id: stage.id, key }, file, body, false);
    const listed = await this.list(userId, projectId, key);
    return { data: { ...listed.data, createdId: created.id } };
  }

  /**
   * A ZIP uploaded straight to «Разбор кода», without a stage — the way a project started as «Только анализ» brings its
   * code. Same checks as stage files; only archives are accepted here.
   */
  async uploadSource(userId: string, projectId: string, file: { buffer: Buffer; size: number; originalname?: string } | undefined, body: Record<string, unknown> | undefined) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true, project: { select: { status: true } } } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (!writeRoles.has(member.role)) throw new ForbiddenException('STAGE_WRITE_FORBIDDEN');
    if (!['draft', 'active', 'live'].includes(member.project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const created = await this.store(userId, projectId, null, file, body, true);
    return { data: { createdId: created.id } };
  }

  /** Removes a source uploaded to «Разбор кода» (its uploader, the owner or a manager); reports made from it stay. */
  async removeSource(userId: string, projectId: string, fileId: string) {
    if (!isUuid(projectId) || !isUuid(fileId)) throw new NotFoundException('FILE_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true } });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    const row = await this.prisma.stageFile.findFirst({ where: { id: fileId, projectId, stageId: null }, select: { id: true, createdByUserId: true, sha256: true } });
    if (!row) throw new NotFoundException('FILE_NOT_FOUND');
    if (!acceptRoles.has(member.role) && !(writeRoles.has(member.role) && row.createdByUserId === userId)) throw new ForbiddenException('FILE_DELETE_FORBIDDEN');
    await this.prisma.$transaction(async (tx) => {
      await tx.stageFile.delete({ where: { id: row.id } });
      await this.core.event(tx, projectId, userId, 'analysis_source_deleted', null, { fileId: row.id, sha256: row.sha256 });
    });
    return { data: { deleted: true } };
  }

  private async store(userId: string, projectId: string, stage: { id: string; key: string } | null, file: { buffer: Buffer; size: number; originalname?: string } | undefined, body: Record<string, unknown> | undefined, onlyZip: boolean) {
    if (!file || !file.buffer?.length) throw new BadRequestException('FILE_REQUIRED');
    this.limits.take('stage-file-upload', userId, StageFilesService.uploadsPerUser, 'FILE_UPLOADS_TOO_FREQUENT');
    if (file.size > STAGE_FILE_LIMITS.fileBytes) throw new UnprocessableEntityException('FILE_TOO_LARGE');
    const name = cleanFileName(body?.name ?? file.originalname);
    if (!name) throw new BadRequestException('FILE_NAME_INVALID');
    const note = cleanNote(body?.note);
    const type = detectStageFile(file.buffer, name);
    if (!type || (onlyZip && type.kind !== 'zip')) throw new UnprocessableEntityException(onlyZip ? 'ANALYSIS_NEEDS_ZIP' : 'FILE_TYPE_NOT_SUPPORTED');
    const [count, used] = await Promise.all([
      this.prisma.stageFile.count({ where: stage ? { stageId: stage.id } : { projectId, stageId: null } }),
      this.prisma.stageFile.aggregate({ where: { projectId }, _sum: { sizeBytes: true } }),
    ]);
    if (count >= STAGE_FILE_LIMITS.perStage) throw new ConflictException('FILE_LIMIT_REACHED');
    if ((used._sum.sizeBytes ?? 0) + file.buffer.length > STAGE_FILE_LIMITS.projectBytes) throw new ConflictException('FILE_STORAGE_FULL');
    if (scanRequired()) {
      const scan = await scanWithClamAv(file.buffer);
      if (scan === 'infected') throw new UnprocessableEntityException('FILE_REJECTED_BY_SCAN');
      if (scan === 'unavailable') throw new ServiceUnavailableException('FILE_SCAN_UNAVAILABLE');
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.stageFile.create({ data: { projectId, stageId: stage?.id ?? null, name, kind: type.kind, mime: type.mime, sizeBytes: file.buffer.length, sha256, note, data: new Uint8Array(file.buffer), createdByUserId: userId }, select: { id: true } });
      await this.core.event(tx, projectId, userId, stage ? 'stage_file_added' : 'analysis_source_added', stage?.key ?? null, { fileId: row.id, kind: type.kind, sizeBytes: file.buffer.length, sha256 });
      return row;
    });
  }

  async download(userId: string, projectId: string, key: string, fileId: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    if (!isUuid(fileId)) throw new NotFoundException('FILE_NOT_FOUND');
    const row = await this.prisma.stageFile.findFirst({ where: { id: fileId, stageId: stage.id }, select: { name: true, mime: true, kind: true, data: true, sha256: true } });
    if (!row) throw new NotFoundException('FILE_NOT_FOUND');
    return { name: row.name, mime: row.kind === 'text' ? 'text/plain; charset=utf-8' : row.mime, data: Buffer.from(row.data), etag: row.sha256 };
  }

  async remove(userId: string, projectId: string, key: string, fileId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!isUuid(fileId)) throw new NotFoundException('FILE_NOT_FOUND');
    const row = await this.prisma.stageFile.findFirst({ where: { id: fileId, stageId: stage.id }, select: { id: true, createdByUserId: true, sha256: true, name: true } });
    if (!row) throw new NotFoundException('FILE_NOT_FOUND');
    const managing = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    if (!managing && row.createdByUserId !== userId) throw new ForbiddenException('FILE_DELETE_FORBIDDEN');
    await this.prisma.$transaction(async (tx) => {
      await tx.stageFile.delete({ where: { id: row.id } });
      await this.core.event(tx, projectId, userId, 'stage_file_deleted', key, { fileId: row.id, sha256: row.sha256 });
    });
    return this.list(userId, projectId, key);
  }
}
