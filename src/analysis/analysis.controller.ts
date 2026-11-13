import { Header, BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AnalysisService } from './analysis.service.js';
import { STAGE_FILE_LIMITS } from './file-types.js';
import { StageFilesService } from './stage-files.service.js';

type Download = { set(headers: Record<string, string>): unknown; send(body: Buffer | string): unknown };

function stageKey(value: string): string {
  if (!/^[a-z]{2,20}$/.test(value)) throw new BadRequestException('INVALID_STAGE_KEY');
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return value.trim() || null;
}

/** `attachment` with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987), so the browser saves instead of opening. */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const safeHeaders = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' };

@Controller('projects/:projectId')
@UseGuards(AuthGuard)
export class AnalysisController {
  constructor(private readonly files: StageFilesService, private readonly analysis: AnalysisService) {}

  @Get('stages/:stageKey/files')
  listFiles(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.files.list(request.user.id, projectId, stageKey(key));
  }

  @Post('stages/:stageKey/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: STAGE_FILE_LIMITS.fileBytes, files: 1, fields: 3, fieldSize: 2048 } }))
  upload(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined, @Body() body: Record<string, unknown> | undefined) {
    return this.files.upload(request.user.id, projectId, stageKey(key), file, body);
  }

  @Get('stages/:stageKey/files/:fileId')
  async download(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('fileId') fileId: string, @Res() response: Download) {
    const file = await this.files.download(request.user.id, projectId, stageKey(key), fileId);
    response.set({ ...safeHeaders, 'Content-Type': file.mime, 'Content-Disposition': attachment(file.name), ETag: `"${file.etag}"` });
    response.send(file.data);
  }

  @Delete('stages/:stageKey/files/:fileId')
  remove(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('fileId') fileId: string) {
    return this.files.remove(request.user.id, projectId, stageKey(key), fileId);
  }

  @Post('analysis-sources')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: STAGE_FILE_LIMITS.fileBytes, files: 1, fields: 3, fieldSize: 2048 } }))
  uploadSource(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined, @Body() body: Record<string, unknown> | undefined) {
    return this.files.uploadSource(request.user.id, projectId, file, body);
  }

  @Delete('analysis-sources/:fileId')
  removeSource(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('fileId') fileId: string) {
    return this.files.removeSource(request.user.id, projectId, fileId);
  }

  @Get('analysis-runs')
  listRuns(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.analysis.list(request.user.id, projectId);
  }

  @Post('analysis-runs')
  createRun(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('INVALID_REQUEST_BODY');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((field) => !['source', 'fileId', 'url', 'ref', 'idempotencyKey'].includes(field))) throw new BadRequestException('UNKNOWN_FIELD');
    if (typeof input.source !== 'string') throw new BadRequestException('ANALYSIS_SOURCE_INVALID');
    const idempotencyKey = optionalText(input.idempotencyKey, 'idempotencyKey', 80);
    if (idempotencyKey && !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) throw new BadRequestException('INVALID_IDEMPOTENCYKEY');
    return this.analysis.create(request.user.id, projectId, {
      source: input.source, fileId: optionalText(input.fileId, 'fileId', 36), url: optionalText(input.url, 'url', 300), ref: optionalText(input.ref, 'ref', 200), idempotencyKey,
    });
  }

  @Get('analysis-runs/:runId')
  getRun(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.analysis.get(request.user.id, projectId, runId);
  }

  @Get('analysis-runs/:runId/compare')
  @Header('Cache-Control', 'no-store')
  compare(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.analysis.compare(request.user.id, projectId, runId);
  }

  @Post('analysis-runs/:runId/findings/:findingId/remark')
  toRemark(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('runId') runId: string, @Param('findingId') findingId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'stageKey')) throw new BadRequestException('INVALID_REQUEST_BODY');
    const key = (body as { stageKey?: unknown }).stageKey;
    if (typeof key !== 'string' || !/^[a-z]{2,20}$/.test(key) || !/^[A-Z_]{3,40}-[0-9a-f]{8}$/.test(findingId)) throw new BadRequestException('INVALID_STAGE_KEY');
    return this.analysis.toRemark(request.user.id, projectId, runId, findingId, key);
  }

  @Get('analysis-runs/:runId/export')
  async exportRun(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('runId') runId: string, @Query('format') format: string | undefined, @Res() response: Download) {
    const file = await this.analysis.export(request.user.id, projectId, runId, format ?? 'md');
    response.set({ ...safeHeaders, 'Content-Type': file.mime, 'Content-Disposition': attachment(file.name) });
    response.send(file.body);
  }
}
