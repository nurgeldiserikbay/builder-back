import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ReviewsService } from './reviews.service.js';

const modes = ['site_only', 'site_and_design', 'design_only'] as const;
const locales = ['en', 'ru', 'kk'] as const;
const findingCategories = ['requirement', 'design', 'backend', 'accessibility', 'performance', 'seo', 'security'] as const;
const findingSeverities = ['critical', 'high', 'medium', 'low', 'info'] as const;

function parseBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  return value as Record<string, unknown>;
}
function rejectUnknown(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
}
function requiredString(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new BadRequestException(`INVALID_${key.toUpperCase()}`);
  return value;
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Controller()
@UseGuards(AuthGuard)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('projects/:projectId/reviews')
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
  ) {
    if (!isUuid(projectId)) throw new BadRequestException('INVALID_PROJECT_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    }
    const body = parseBody(raw);
    rejectUnknown(body, ['title', 'mode', 'locale']);
    const title = requiredString(body, 'title', 1, 120).trim();
    const mode = body.mode;
    const locale = body.locale;
    if (!modes.includes(mode as (typeof modes)[number])) throw new BadRequestException('INVALID_REVIEW_MODE');
    if (!locales.includes(locale as (typeof locales)[number])) throw new BadRequestException('INVALID_LOCALE');
    return this.reviews.create(request.user.id, projectId, {
      title,
      mode: mode as (typeof modes)[number],
      locale: locale as (typeof locales)[number],
    }, idempotencyKey);
  }


  @Get('reviews/:reviewId/pages')
  listPages(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string) {
    return this.reviews.listPages(request.user.id, reviewId);
  }

  @Post('reviews/:reviewId/sources/url')
  async registerUrl(
    @Req() request: AuthenticatedRequest,
    @Param('reviewId') reviewId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
  ) {
    if (!isUuid(reviewId)) throw new BadRequestException('INVALID_REVIEW_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    }
    const body = parseBody(raw);
    rejectUnknown(body, ['url']);
    const url = requiredString(body, 'url', 1, 2048);
    return this.reviews.registerUrl(request.user.id, reviewId, url, idempotencyKey);
  }

  @Post('reviews/:reviewId/sources/design-upload')
  async reserveDesignUpload(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() raw: unknown) {
    if (!isUuid(reviewId)) throw new BadRequestException('INVALID_REVIEW_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    const body = parseBody(raw);
    rejectUnknown(body, ['fileName', 'contentType', 'sizeBytes', 'sha256']);
    return this.reviews.reserveDesignUpload(request.user.id, reviewId, {
      fileName: requiredString(body, 'fileName', 1, 255),
      contentType: requiredString(body, 'contentType', 1, 128),
      sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : Number.NaN,
      sha256: requiredString(body, 'sha256', 64, 64),
    }, idempotencyKey);
  }

  @Post('reviews/:reviewId/sources/design-upload/:assetId/complete')
  @HttpCode(HttpStatus.OK)
  async completeDesignUpload(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('assetId') assetId: string) {
    if (!isUuid(reviewId) || !isUuid(assetId)) throw new BadRequestException('INVALID_DESIGN_ASSET_ID');
    return this.reviews.completeDesignUpload(request.user.id, reviewId, assetId);
  }

  @Get('reviews/:reviewId/sources/design-upload/:assetId/url')
  async getDesignAssetUrl(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('assetId') assetId: string) {
    if (!isUuid(reviewId) || !isUuid(assetId)) throw new BadRequestException('INVALID_DESIGN_ASSET_ID');
    return this.reviews.getDesignAssetUrl(request.user.id, reviewId, assetId);
  }

  @Put('reviews/:reviewId/page-mappings/:pageId')
  async savePageMapping(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('pageId') pageId: string, @Body() raw: unknown) {
    if (!isUuid(reviewId) || !isUuid(pageId)) throw new BadRequestException('INVALID_PAGE_ID');
    const body = parseBody(raw);
    rejectUnknown(body, ['designAssetId', 'viewport', 'requirementIds']);
    const designAssetId = body.designAssetId ?? null;
    if (designAssetId !== null && (typeof designAssetId !== 'string' || !isUuid(designAssetId))) throw new BadRequestException('INVALID_DESIGN_ASSET_ID');
    const viewport = parseBody(body.viewport);
    rejectUnknown(viewport, ['width', 'height', 'deviceScale']);
    const width = viewport.width;
    const height = viewport.height;
    const scale = viewport.deviceScale;
    const requirementIds = body.requirementIds;
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 320 || width > 3840) throw new BadRequestException('INVALID_VIEWPORT_WIDTH');
    if (typeof height !== 'number' || !Number.isInteger(height) || height < 568 || height > 4320) throw new BadRequestException('INVALID_VIEWPORT_HEIGHT');
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > 3) throw new BadRequestException('INVALID_DEVICE_SCALE');
    if (!Array.isArray(requirementIds) || requirementIds.length > 100 || requirementIds.some((id) => typeof id !== 'string' || !isUuid(id))) throw new BadRequestException('INVALID_REQUIREMENT_IDS');
    return this.reviews.savePageMapping(request.user.id, reviewId, pageId, {
      designAssetId: designAssetId as string | null,
      viewportWidth: width, viewportHeight: height, deviceScale: scale, requirementIds: requirementIds as string[],
    });
  }

  @Post('reviews/:reviewId/captures')
  @HttpCode(HttpStatus.ACCEPTED)
  async queueCapture(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() raw: unknown) {
    if (!isUuid(reviewId)) throw new BadRequestException('INVALID_REVIEW_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    const body = parseBody(raw);
    rejectUnknown(body, ['pageId', 'viewport']);
    const pageId = requiredString(body, 'pageId', 36, 36);
    if (!isUuid(pageId)) throw new BadRequestException('INVALID_PAGE_ID');
    const viewport = parseBody(body.viewport);
    rejectUnknown(viewport, ['width', 'height', 'deviceScale']);
    const width = viewport.width;
    const height = viewport.height;
    const deviceScale = viewport.deviceScale;
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 320 || width > 3840) throw new BadRequestException('INVALID_VIEWPORT_WIDTH');
    if (typeof height !== 'number' || !Number.isInteger(height) || height < 568 || height > 4320) throw new BadRequestException('INVALID_VIEWPORT_HEIGHT');
    if (typeof deviceScale !== 'number' || !Number.isFinite(deviceScale) || deviceScale < 1 || deviceScale > 3) throw new BadRequestException('INVALID_DEVICE_SCALE');
    return this.reviews.queueCapture(request.user.id, reviewId, { pageId, viewportWidth: width, viewportHeight: height, deviceScale }, idempotencyKey);
  }

  @Post('reviews/:reviewId/requirements')
  async createRequirement(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() raw: unknown) {
    if (!isUuid(reviewId)) throw new BadRequestException('INVALID_REVIEW_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    const body = parseBody(raw);
    rejectUnknown(body, ['pageId', 'title', 'category', 'details']);
    const pageId = requiredString(body, 'pageId', 36, 36);
    if (!isUuid(pageId)) throw new BadRequestException('INVALID_PAGE_ID');
    const title = requiredString(body, 'title', 1, 500).trim();
    if (!title) throw new BadRequestException('INVALID_REQUIREMENT_TITLE');
    const categories = ['requirement', 'design', 'backend', 'accessibility', 'performance', 'seo', 'security'] as const;
    const category = body.category ?? 'requirement';
    if (!categories.includes(category as (typeof categories)[number])) throw new BadRequestException('INVALID_REQUIREMENT_CATEGORY');
    const details = body.details === undefined || body.details === null ? null : requiredString(body, 'details', 0, 4000);
    return this.reviews.createRequirement(request.user.id, reviewId, idempotencyKey, {
      pageId, title, category: category as (typeof categories)[number], details,
    });
  }

  @Get('reviews/:reviewId/pages/:pageId/requirements')
  async listRequirements(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('pageId') pageId: string) {
    if (!isUuid(reviewId) || !isUuid(pageId)) throw new BadRequestException('INVALID_REVIEW_PAGE_ID');
    return this.reviews.listRequirements(request.user.id, reviewId, pageId);
  }

  @Patch('reviews/:reviewId/requirements/:requirementId')
  async updateRequirement(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('requirementId') requirementId: string, @Body() raw: unknown) {
    if (!isUuid(reviewId) || !isUuid(requirementId)) throw new BadRequestException('INVALID_REQUIREMENT_ID');
    const body = parseBody(raw);
    rejectUnknown(body, ['status', 'verificationNote', 'evidenceCaptureId']);
    const statuses = ['pending', 'satisfied', 'failed', 'blocked', 'unknown'] as const;
    if (!statuses.includes(body.status as (typeof statuses)[number])) throw new BadRequestException('INVALID_REQUIREMENT_STATUS');
    const verificationNote = body.verificationNote === undefined || body.verificationNote === null ? null : requiredString(body, 'verificationNote', 0, 2000);
    const evidenceCaptureId = body.evidenceCaptureId ?? null;
    if (evidenceCaptureId !== null && (typeof evidenceCaptureId !== 'string' || !isUuid(evidenceCaptureId))) throw new BadRequestException('INVALID_EVIDENCE_CAPTURE_ID');
    return this.reviews.updateRequirement(request.user.id, reviewId, requirementId, {
      status: body.status as (typeof statuses)[number], verificationNote, evidenceCaptureId: evidenceCaptureId as string | null,
    });
  }

  @Get('reviews/:reviewId/pages/:pageId/findings')
  async listFindings(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('pageId') pageId: string) {
    if (!isUuid(reviewId) || !isUuid(pageId)) throw new BadRequestException('INVALID_REVIEW_PAGE_ID');
    return this.reviews.listFindings(request.user.id, reviewId, pageId);
  }

  @Post('reviews/:reviewId/findings')
  async createFinding(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() raw: unknown) {
    if (!isUuid(reviewId)) throw new BadRequestException('INVALID_REVIEW_ID');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new BadRequestException('INVALID_IDEMPOTENCY_KEY');
    const body = parseBody(raw);
    rejectUnknown(body, ['evidenceCaptureId', 'category', 'severity', 'summary', 'coordinate']);
    const captureId = requiredString(body, 'evidenceCaptureId', 36, 36);
    if (!isUuid(captureId)) throw new BadRequestException('INVALID_EVIDENCE_CAPTURE_ID');
    const category = body.category;
    const severity = body.severity;
    if (!findingCategories.includes(category as (typeof findingCategories)[number])) throw new BadRequestException('INVALID_FINDING_CATEGORY');
    if (!findingSeverities.includes(severity as (typeof findingSeverities)[number])) throw new BadRequestException('INVALID_FINDING_SEVERITY');
    const summary = requiredString(body, 'summary', 1, 500).trim();
    if (!summary) throw new BadRequestException('INVALID_SUMMARY');
    let coordinate: { x: number; y: number } | null = null;
    if (body.coordinate !== undefined && body.coordinate !== null) {
      const point = parseBody(body.coordinate);
      rejectUnknown(point, ['x', 'y']);
      if (typeof point.x !== 'number' || !Number.isFinite(point.x) || point.x < 0 || point.x > 1) throw new BadRequestException('INVALID_COORDINATE_X');
      if (typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y < 0 || point.y > 1) throw new BadRequestException('INVALID_COORDINATE_Y');
      coordinate = { x: point.x, y: point.y };
    }
    return this.reviews.createFinding(request.user.id, reviewId, idempotencyKey, {
      evidenceCaptureId: captureId,
      category: category as (typeof findingCategories)[number],
      severity: severity as (typeof findingSeverities)[number],
      summary,
      coordinate,
    });
  }

  @Patch('reviews/:reviewId/findings/:findingId')
  async updateFinding(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('findingId') findingId: string, @Body() raw: unknown) {
    if (!isUuid(reviewId) || !isUuid(findingId)) throw new BadRequestException('INVALID_FINDING_ID');
    const body = parseBody(raw);
    rejectUnknown(body, ['status']);
    const statuses = ['open', 'accepted', 'dismissed', 'fixed', 'unknown'] as const;
    if (!statuses.includes(body.status as (typeof statuses)[number])) throw new BadRequestException('INVALID_FINDING_STATUS');
    return this.reviews.updateFindingStatus(request.user.id, reviewId, findingId, body.status as (typeof statuses)[number]);
  }

  @Get('reviews/:reviewId/captures/:captureId')
  async getCapture(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string, @Param('captureId') captureId: string) {
    if (!isUuid(reviewId) || !isUuid(captureId)) throw new BadRequestException('INVALID_CAPTURE_ID');
    return this.reviews.getCapture(request.user.id, reviewId, captureId);
  }

  @Get('reviews/:reviewId')
  get(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string) {
    return this.reviews.get(request.user.id, reviewId);
  }
}
