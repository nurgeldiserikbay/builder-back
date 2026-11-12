import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { InsightsService } from './insights.service.js';

@Controller('projects/:projectId/insights')
@UseGuards(AuthGuard)
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('days') days?: string) {
    return this.insights.project(request.user.id, projectId, days);
  }
}
