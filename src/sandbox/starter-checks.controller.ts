import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StarterChecksService } from './starter-checks.js';

@Controller('projects/:projectId/handoff/starter')
@UseGuards(AuthGuard)
export class StarterChecksController {
  constructor(private readonly starter: StarterChecksService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.starter.get(request.user.id, projectId);
  }

  @Post()
  @HttpCode(202)
  start(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.starter.start(request.user.id, projectId);
  }

  @Get('files')
  files(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.starter.files(request.user.id, projectId);
  }
}
