import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { BrowserChecksService } from './browser-checks.js';

function versionId(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException('INVALID_VERSIONID');
  return value;
}

@Controller('projects/:projectId/stages/build/browser-check')
@UseGuards(AuthGuard)
export class BrowserChecksController {
  constructor(private readonly checks: BrowserChecksService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('versionId') version: string | undefined) {
    return this.checks.get(request.user.id, projectId, versionId(version));
  }

  @Post()
  @HttpCode(202)
  rerun(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('versionId') version: string | undefined) {
    return this.checks.rerun(request.user.id, projectId, versionId(version));
  }
}
