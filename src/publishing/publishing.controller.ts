import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PublishingService } from './publishing.service.js';
import { TelegramLinkService } from './telegram-link.service.js';
import { MastersService } from './masters.service.js';

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

  @Post('projects/:projectId/publication/domain')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  setDomain(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['domain']);
    if (typeof input.domain !== 'string' || input.domain.length > 300) throw new BadRequestException('DOMAIN_INVALID');
    return this.publishing.setDomain(request.user.id, projectId, input.domain);
  }

  @Post('projects/:projectId/publication/domain/check')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  checkDomain(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.publishing.checkDomain(request.user.id, projectId);
  }

  @Delete('projects/:projectId/publication/domain')
  @UseGuards(AuthGuard)
  removeDomain(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.publishing.removeDomain(request.user.id, projectId);
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

  @Get('projects/:projectId/bookings')
  @UseGuards(AuthGuard)
  bookings(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('scope') scope?: string) {
    if (scope !== undefined && scope !== 'upcoming' && scope !== 'past') throw new BadRequestException('INVALID_SCOPE');
    return this.publishing.bookings(request.user.id, projectId, scope ?? 'upcoming');
  }

  @Post('projects/:projectId/bookings/:bookingId/status')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  bookingStatus(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('bookingId') bookingId: string, @Body() raw: unknown) {
    const status = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every((key) => key === 'status') ? (raw as { status?: unknown }).status : undefined;
    if (status !== 'cancelled_by_owner' && status !== 'done' && status !== 'no_show') throw new BadRequestException('INVALID_STATUS');
    return this.publishing.setBookingStatus(request.user.id, projectId, bookingId, status);
  }

  @Get('projects/:projectId/orders')
  @UseGuards(AuthGuard)
  orders(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('scope') scope?: string) {
    if (scope !== undefined && scope !== 'open' && scope !== 'closed') throw new BadRequestException('INVALID_SCOPE');
    return this.publishing.orders(request.user.id, projectId, scope ?? 'open');
  }

  @Post('projects/:projectId/orders/:orderId/status')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  orderStatus(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('orderId') orderId: string, @Body() raw: unknown) {
    const status = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every((key) => key === 'status') ? (raw as { status?: unknown }).status : undefined;
    if (status !== 'confirmed' && status !== 'done' && status !== 'cancelled_by_owner') throw new BadRequestException('INVALID_STATUS');
    return this.publishing.setOrderStatus(request.user.id, projectId, orderId, status);
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

@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @Get('projects/:projectId/masters')
  @UseGuards(AuthGuard)
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.masters.list(request.user.id, projectId);
  }

  @Post('projects/:projectId/masters/:masterKey/invite')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  invite(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('masterKey') masterKey: string, @Body() raw: unknown) {
    const input = body(raw, ['email']);
    if (typeof input.email !== 'string') throw new BadRequestException('EMAIL_INVALID');
    if (!/^[a-z0-9]{2,12}$/.test(masterKey)) throw new BadRequestException('MASTER_NOT_FOUND');
    return this.masters.invite(request.user.id, projectId, masterKey, input.email);
  }

  @Delete('projects/:projectId/masters/access/:accessId')
  @UseGuards(AuthGuard)
  revoke(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('accessId') accessId: string) {
    return this.masters.revoke(request.user.id, projectId, accessId);
  }

  @Get('master-invites/:token')
  inviteInfo(@Param('token') token: string) {
    return this.masters.inviteInfo(token);
  }

  @Post('master-invites/:token/accept')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  accept(@Req() request: AuthenticatedRequest, @Param('token') token: string) {
    return this.masters.accept(request.user.id, request.user.email, token);
  }

  @Get('me/master-bookings')
  @UseGuards(AuthGuard)
  mine(@Req() request: AuthenticatedRequest) {
    return this.masters.myBookings(request.user.id);
  }

  @Post('me/master-bookings/:bookingId/status')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  mark(@Req() request: AuthenticatedRequest, @Param('bookingId') bookingId: string, @Body() raw: unknown) {
    const input = body(raw, ['status']);
    if (input.status !== 'done' && input.status !== 'no_show') throw new BadRequestException('INVALID_STATUS');
    return this.masters.markVisit(request.user.id, bookingId, input.status);
  }
}
