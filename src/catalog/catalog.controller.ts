import { BadRequestException, Body, Controller, Delete, Res, UploadedFile, UseInterceptors, Get, Header, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_UPLOAD_BYTES } from '../images/image-processing.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { CatalogService } from './catalog.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return input;
}
const optionalText = (value: unknown, code: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new BadRequestException(code);
  return value;
};

/** Catalog for signed-in people; specialists edit their own card under /me. */
@Controller()
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('specialists')
  @Header('Cache-Control', 'no-store')
  list(@Query('stage') stage?: string) {
    return this.catalog.list(stage?.trim() ? stage.trim() : null);
  }

  @Get('specialists/:profileId')
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('profileId') profileId: string) {
    return this.catalog.get(profileId, request.user.id);
  }

  @Get('me/specialist-profile')
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: AuthenticatedRequest) {
    return this.catalog.mine(request.user.id);
  }

  @Put('me/specialist-profile')
  save(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    const input = body(raw, ['displayName', 'headline', 'about', 'stageKeys', 'hourlyRate', 'city', 'published', 'portfolio']);
    if (typeof input.displayName !== 'string') throw new BadRequestException('PROFILE_NAME_INVALID');
    if (typeof input.headline !== 'string') throw new BadRequestException('PROFILE_HEADLINE_INVALID');
    if (!Array.isArray(input.stageKeys) || input.stageKeys.length > 20 || input.stageKeys.some((key) => typeof key !== 'string')) throw new BadRequestException('PROFILE_STAGE_INVALID');
    if (input.hourlyRate !== null && input.hourlyRate !== undefined && typeof input.hourlyRate !== 'number') throw new BadRequestException('PROFILE_RATE_INVALID');
    if (typeof input.published !== 'boolean') throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.catalog.saveMine(request.user.id, {
      displayName: input.displayName, headline: input.headline, about: optionalText(input.about, 'PROFILE_ABOUT_TOO_LONG'), stageKeys: input.stageKeys as string[],
      hourlyRate: (input.hourlyRate as number | null | undefined) ?? null, city: optionalText(input.city, 'PROFILE_CITY_INVALID'), published: input.published,
    }, input.portfolio);
  }

  @Post('me/specialist-profile/photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } }))
  uploadPhoto(@Req() request: AuthenticatedRequest, @UploadedFile() file: { buffer: Buffer; size: number } | undefined) {
    return this.catalog.uploadPhoto(request.user.id, file);
  }

  @Delete('me/specialist-profile/photos/:photoId')
  deletePhoto(@Req() request: AuthenticatedRequest, @Param('photoId') photoId: string) {
    return this.catalog.deletePhoto(request.user.id, photoId);
  }

  @Get('specialist-photos/:photoId')
  async photo(@Req() request: AuthenticatedRequest, @Param('photoId') photoId: string, @Res() response: { set(headers: Record<string, string>): unknown; send(body: Buffer): unknown }) {
    const photo = await this.catalog.photo(request.user.id, photoId);
    response.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600', ETag: `"${photo.etag}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    response.send(photo.data);
  }

  @Post('projects/:projectId/assignments/:assignmentId/review')
  @HttpCode(200)
  review(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('assignmentId') assignmentId: string, @Body() raw: unknown) {
    const input = body(raw, ['rating', 'text']);
    return this.catalog.review(request.user.id, projectId, assignmentId, input.rating, input.text ?? null);
  }

  @Post('me/reviews/:reviewId/report')
  @HttpCode(200)
  report(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Body() raw: unknown) {
    return this.catalog.report(request.user.id, reviewId, body(raw, ['reason']).reason);
  }

  @Post('me/reviews/:reviewId/reply')
  @HttpCode(200)
  reply(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Body() raw: unknown) {
    return this.catalog.reply(request.user.id, reviewId, body(raw, ['text']).text);
  }
}

/** Reported reviews: super admins decide, operations auditors read. */
@Controller('admin/reviews')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminReviewsController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  list(@Query('status') status?: string) {
    return this.catalog.staffReports(status === 'decided' ? 'decided' : 'pending');
  }

  @Post(':reviewId/decide')
  @HttpCode(200)
  @StaffRoles('super_admin')
  decide(@Param('reviewId') reviewId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = body(raw, ['decision', 'note']);
    return this.catalog.staffDecide(request.staff.id, reviewId, input.decision, input.note);
  }
}
