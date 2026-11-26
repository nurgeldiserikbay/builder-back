import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Ip, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { NetworkAgentService } from './network-agent.service.js';

const record = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});

/** The owner's side: the project's agent, its key and its jobs. */
@Controller('projects/:projectId/network-agent')
@UseGuards(AuthGuard)
export class NetworkAgentController {
  constructor(private readonly agents: NetworkAgentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.agents.view(request.user.id, projectId);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.agents.create(request.user.id, projectId, { name: record(body).name });
  }

  @Delete()
  revoke(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.agents.revoke(request.user.id, projectId);
  }

  @Post('jobs')
  @HttpCode(202)
  start(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = record(body);
    return this.agents.startJob(request.user.id, projectId, { kind: input.kind, confirm: input.confirm, taskId: input.taskId });
  }

  /** The program to run inside the owner's network. */
  @Get('program')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="buildpath-agent.mjs"')
  async program(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    await this.agents.view(request.user.id, projectId);
    return this.agents.program();
  }
}

/** The agent's side: authenticated by its key alone, no session. */
@Controller('network-agent')
export class NetworkAgentGatewayController {
  constructor(private readonly agents: NetworkAgentService) {}

  @Post('hello')
  @HttpCode(200)
  hello(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Body() body: unknown) {
    return this.agents.hello(authorization, ip, body);
  }

  @Post('monitor')
  @HttpCode(200)
  monitor(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Body() body: unknown) {
    return this.agents.monitor(authorization, ip, body);
  }

  @Post('jobs/next')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  next(@Headers('authorization') authorization: string | undefined, @Ip() ip: string) {
    return this.agents.next(authorization, ip);
  }

  @Get('jobs/:jobId/files')
  @Header('Cache-Control', 'no-store')
  files(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Param('jobId') jobId: string) {
    return this.agents.files(authorization, ip, jobId);
  }

  @Post('jobs/:jobId/result')
  @HttpCode(200)
  result(@Headers('authorization') authorization: string | undefined, @Ip() ip: string, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.agents.result(authorization, ip, jobId, body);
  }
}
