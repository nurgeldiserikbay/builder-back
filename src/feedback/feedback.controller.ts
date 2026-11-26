import { Body, Controller, Get, Header, HttpCode, Ip, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { FeedbackService } from './feedback.service.js';

const record = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});

/** The owner's side: turn the application's feedback form on or off, or give it a new address. */
@Controller('projects/:projectId/feedback-inbox')
@UseGuards(AuthGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.feedback.get(request.user.id, projectId);
  }

  @Put()
  set(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = record(body);
    return this.feedback.set(request.user.id, projectId, { enabled: input.enabled, renew: input.renew });
  }
}

/**
 * The public side, called from the application's own page on any origin: no session, no cookies. The form sends
 * application/x-www-form-urlencoded (a «simple» request, so the browser sends no preflight); the answer may be read by any
 * page, and it says nothing but «accepted».
 */
@Controller('feedback')
export class FeedbackGatewayController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post(':token')
  @HttpCode(202)
  @Header('Access-Control-Allow-Origin', '*')
  @Header('Cache-Control', 'no-store')
  receive(@Param('token') token: string, @Ip() ip: string, @Body() body: unknown) {
    return this.feedback.receive(token, ip, body);
  }
}
