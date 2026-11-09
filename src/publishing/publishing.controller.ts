import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PublishingService } from './publishing.service.js';
import { TelegramLinkService } from './telegram-link.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !fields.includes(field))) throw new BadRequestException('UNKNOWN_FIELD');
  return record;
}
function slugParam(value: unknown): string {
  if (typeof value !== 'string' || value.length > 60) throw new BadRequestException('INVALID_SLUG');
  return value.trim().toLowerCase();
}

@Controller()
export class PublishingController {
  constructor(private readonly publishing: PublishingService, private readonly telegram: TelegramLinkService) {}

  @Get('projects/:projectId/publication')
  @UseGuards(AuthGuard)
  status(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.publishing.status(request.user.id, projectId);
  }

  @Get('projects/:projectId/publication/slug-check')
  @UseGuards(AuthGuard)
  checkSlug(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('slug') slug?: string) {
    return this.publishing.checkSlug(request.user.id, projectId, slugParam(slug));
  }

  @Post('projects/:projectId/publication')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  publish(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['slug', 'confirm']);
    if (input.confirm !== true) throw new BadRequestException('PUBLISH_CONFIRMATION_REQUIRED');
    return this.publishing.publish(request.user.id, projectId, { slug: slugParam(input.slug), confirm: true });
  }

  @Post('projects/:projectId/publication/unpublish')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  unpublish(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.publishing.unpublish(request.user.id, projectId);
  }

  @Post('projects/:projectId/publication/settings')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  settings(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['notifyTelegram', 'notifyEmail']);
    if (typeof input.notifyTelegram !== 'boolean' || typeof input.notifyEmail !== 'boolean') throw new BadRequestException('INVALID_SETTINGS');
    return this.publishing.settings(request.user.id, projectId, { notifyTelegram: input.notifyTelegram, notifyEmail: input.notifyEmail });
  }

  @Get('projects/:projectId/leads')
  @UseGuards(AuthGuard)
  leads(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('cursor') cursor?: string, @Query('limit') rawLimit?: string) {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('INVALID_LIMIT');
    return this.publishing.leads(request.user.id, projectId, cursor, limit);
  }

  @Delete('projects/:projectId/leads/:leadId')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async deleteLead(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('leadId') leadId: string) {
    await this.publishing.deleteLead(request.user.id, projectId, leadId);
  }

  @Get('me/telegram')
  @UseGuards(AuthGuard)
  telegramStatus(@Req() request: AuthenticatedRequest) {
    return this.telegram.status(request.user.id);
  }

  @Post('me/telegram/link')
  @UseGuards(AuthGuard)
  telegramLink(@Req() request: AuthenticatedRequest) {
    return this.telegram.createLink(request.user.id);
  }

  @Delete('me/telegram')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async telegramUnlink(@Req() request: AuthenticatedRequest) {
    await this.telegram.unlink(request.user.id);
  }

  /** Telegram Bot API webhook; authenticated by the secret token Telegram sends in a header. */
  @Post('telegram/webhook')
  @HttpCode(200)
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: unknown) {
    const accepted = await this.telegram.handleUpdate(secret, update);
    if (!accepted) throw new NotFoundException();
    return { ok: true };
  }
}
