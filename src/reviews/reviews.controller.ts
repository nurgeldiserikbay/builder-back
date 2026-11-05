import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ReviewsService } from './reviews.service.js';

const modes = ['site_only', 'site_and_design', 'design_only'] as const;
const locales = ['en', 'ru', 'kk'] as const;

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

  @Get('reviews/:reviewId')
  get(@Req() request: AuthenticatedRequest, @Param('reviewId') reviewId: string) {
    return this.reviews.get(request.user.id, reviewId);
  }
}
