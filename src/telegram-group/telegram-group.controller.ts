import { Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { TelegramGroupService } from './telegram-group.service.js';

/** The project's Telegram group: whether there is one, a one-time «add to group» link, unlinking. */
@Controller('projects/:projectId/telegram-group')
@UseGuards(AuthGuard)
export class TelegramGroupController {
  constructor(private readonly groups: TelegramGroupService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.groups.get(request.user.id, projectId);
  }

  @Post('link')
  @HttpCode(200)
  link(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.groups.link(request.user.id, projectId);
  }

  @Post('unlink')
  @HttpCode(200)
  unlink(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.groups.unlink(request.user.id, projectId);
  }
}
