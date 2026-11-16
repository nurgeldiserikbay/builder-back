import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StarterChecksService } from './starter-checks.js';
import { AppCodeService } from './app-code.js';

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

@Controller('projects/:projectId/handoff/app-code')
@UseGuards(AuthGuard)
export class AppCodeController {
  constructor(private readonly appCode: AppCodeService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.appCode.get(request.user.id, projectId);
  }

  @Post()
  @HttpCode(202)
  generate(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'instruction')) throw new BadRequestException('INVALID_BODY');
    if (record.instruction !== undefined && record.instruction !== null && typeof record.instruction !== 'string') throw new BadRequestException('INVALID_INSTRUCTION');
    return this.appCode.generate(request.user.id, projectId, { instruction: (record.instruction as string | null | undefined) ?? null });
  }

  @Get('files')
  files(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.appCode.files(request.user.id, projectId);
  }
}
