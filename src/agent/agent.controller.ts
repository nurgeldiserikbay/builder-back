import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AgentTasksService } from './agent-tasks.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const taskId = (value: string) => { if (!uuid.test(value)) throw new BadRequestException('AGENT_TASK_NOT_FOUND'); return value; };

@Controller('projects/:projectId/agent/tasks')
@UseGuards(AuthGuard)
export class AgentController {
  constructor(private readonly tasks: AgentTasksService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.tasks.get(request.user.id, projectId);
  }

  @Post()
  @HttpCode(202)
  start(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['instruction', 'kind', 'baseTaskId', 'base'].includes(key))) throw new BadRequestException('INVALID_BODY');
    if (record.kind !== undefined && record.kind !== 'build_app' && record.kind !== 'change_app') throw new BadRequestException('AGENT_TASK_KIND_INVALID');
    const change = record.kind === 'change_app';
    // A change starts either from an earlier task (baseTaskId) or from the repository's main branch (base: "repository").
    const fromRepository = record.base === 'repository';
    if (record.base !== undefined && !fromRepository) throw new BadRequestException('INVALID_BODY');
    if (change !== (typeof record.baseTaskId === 'string' || fromRepository) || (fromRepository && record.baseTaskId !== undefined)) throw new BadRequestException('AGENT_TASK_KIND_INVALID');
    if (typeof record.baseTaskId === 'string' && !/^[0-9a-f-]{36}$/i.test(record.baseTaskId)) throw new BadRequestException('INVALID_BODY');
    if (record.instruction !== undefined && record.instruction !== null && typeof record.instruction !== 'string') throw new BadRequestException('INVALID_INSTRUCTION');
    return this.tasks.start(request.user.id, projectId, { instruction: (record.instruction as string | null | undefined) ?? null, baseTaskId: change && !fromRepository ? record.baseTaskId as string : null, fromRepository });
  }

  @Post(':taskId/stop')
  @HttpCode(200)
  stop(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('taskId') id: string) {
    return this.tasks.stop(request.user.id, projectId, taskId(id));
  }

  @Post(':taskId/push')
  @HttpCode(200)
  push(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('taskId') id: string, @Body() body: unknown) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'confirm')) throw new BadRequestException('INVALID_BODY');
    return this.tasks.push(request.user.id, projectId, taskId(id), record.confirm === true);
  }

  @Get(':taskId/demo')
  @Header('Cache-Control', 'no-store')
  demo(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('taskId') id: string) {
    return this.tasks.demo(request.user.id, projectId, taskId(id));
  }

  @Get(':taskId/files')
  @Header('Cache-Control', 'no-store')
  files(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('taskId') id: string) {
    return this.tasks.files(request.user.id, projectId, taskId(id));
  }
}

/** Step 4: the address where the owner runs the application, checked by /api/health. */
@Controller('projects/:projectId/agent/deployment')
@UseGuards(AuthGuard)
export class AgentDeploymentController {
  constructor(private readonly tasks: AgentTasksService) {}

  @Post('check')
  @HttpCode(200)
  checkDeployment(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'url') || typeof record.url !== 'string' || record.url.length > 300) throw new BadRequestException('APP_URL_INVALID');
    return this.tasks.checkDeployment(request.user.id, projectId, record.url);
  }
}
