import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
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
    const input = body(raw, ['displayName', 'headline', 'about', 'stageKeys', 'hourlyRate', 'city', 'published']);
    if (typeof input.displayName !== 'string') throw new BadRequestException('PROFILE_NAME_INVALID');
    if (typeof input.headline !== 'string') throw new BadRequestException('PROFILE_HEADLINE_INVALID');
    if (!Array.isArray(input.stageKeys) || input.stageKeys.length > 20 || input.stageKeys.some((key) => typeof key !== 'string')) throw new BadRequestException('PROFILE_STAGE_INVALID');
    if (input.hourlyRate !== null && input.hourlyRate !== undefined && typeof input.hourlyRate !== 'number') throw new BadRequestException('PROFILE_RATE_INVALID');
    if (typeof input.published !== 'boolean') throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.catalog.saveMine(request.user.id, {
      displayName: input.displayName, headline: input.headline, about: optionalText(input.about, 'PROFILE_ABOUT_TOO_LONG'), stageKeys: input.stageKeys as string[],
      hourlyRate: (input.hourlyRate as number | null | undefined) ?? null, city: optionalText(input.city, 'PROFILE_CITY_INVALID'), published: input.published,
    });
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
