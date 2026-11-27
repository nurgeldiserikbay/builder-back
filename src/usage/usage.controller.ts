import { Body, Controller, Get, Header, Headers, HttpCode, Ip, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { UsageService } from './usage.service.js';

const record = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});

/** The owner's side: the report, and turning analytics on or off or giving it a new address. */
@Controller('projects/:projectId/usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('days') days: string | undefined) {
    return this.usage.get(request.user.id, projectId, days);
  }

  @Put()
  set(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = record(body);
    return this.usage.set(request.user.id, projectId, { enabled: input.enabled, renew: input.renew });
  }
}

/**
 * The public side, called from the application's pages on any origin with navigator.sendBeacon: no session, no cookies,
 * form-encoded (a «simple» request, no preflight). The answer is empty and the same whatever was counted.
 */
@Controller('usage')
export class UsageGatewayController {
  constructor(private readonly usage: UsageService) {}

  @Post(':token')
  @HttpCode(204)
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'no-store')
  async receive(@Param('token') token: string, @Ip() ip: string, @Headers('user-agent') agent: string | undefined, @Body() body: unknown): Promise<void> {
    await this.usage.receive(token, ip, String(agent ?? '').slice(0, 300), body);
  }
}
