import { BadRequestException, Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { MonitoringService } from './monitoring.service.js';

@Controller('projects/:projectId/monitoring')
@UseGuards(AuthGuard)
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.monitoring.status(request.user.id, projectId);
  }

  /** Body: { weeklyReport: boolean }. Owner or manager. */
  @Post()
  set(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'weeklyReport') || typeof input.weeklyReport !== 'boolean') throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.monitoring.setWeeklyReport(request.user.id, projectId, input.weeklyReport);
  }
}
