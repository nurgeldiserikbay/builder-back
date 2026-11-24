import { Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { InboxService } from './inbox.service.js';

@Controller()
@UseGuards(AuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** «Входящие»: what waits for this person across projects, and recent updates by others. */
  @Get('me/inbox')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest) {
    return this.inbox.inbox(request.user.id);
  }

  @Post('me/inbox/seen')
  @HttpCode(200)
  seen(@Req() request: AuthenticatedRequest) {
    return this.inbox.markSeen(request.user.id);
  }

  /** The project's activity log («Журнал»), with the viewer's access applied. */
  @Get('projects/:projectId/activity')
  @Header('Cache-Control', 'no-store')
  activity(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query() query: Record<string, string | undefined>) {
    return this.inbox.activity(request.user.id, projectId, { cursor: query.cursor, kind: query.kind, stageKey: query.stageKey, limit: query.limit });
  }
}
