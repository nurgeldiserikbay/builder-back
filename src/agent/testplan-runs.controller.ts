import { BadRequestException, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { BrowserCaseRunsService } from './browser-case-runs.js';

/** The AI agent in the browser on the test plan's cases, and the agent's test code behind each case. */
@Controller('projects/:projectId/testplan')
@UseGuards(AuthGuard)
export class TestPlanRunsController {
  constructor(private readonly runs: BrowserCaseRunsService) {}

  @Get('browser-runs/latest')
  @Header('Cache-Control', 'no-store')
  latest(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.runs.latest(request.user.id, projectId);
  }

  @Post('browser-runs')
  @HttpCode(202)
  start(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.runs.start(request.user.id, projectId);
  }

  @Get('cases/:caseKey/test')
  caseTest(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('caseKey') caseKey: string) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(caseKey)) throw new BadRequestException('CASE_NOT_FOUND');
    return this.runs.caseTest(request.user.id, projectId, caseKey);
  }
}
