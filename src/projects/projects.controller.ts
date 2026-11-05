import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ProjectsService } from './projects.service.js';

const startModes = ['build', 'improve', 'design_implementation', 'analysis_only'] as const;
const locales = ['en', 'ru', 'kk'] as const;

function parseBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  return value as Record<string, unknown>;
}
function rejectUnknown(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((field) => !fields.includes(field))) throw new BadRequestException('UNKNOWN_FIELD');
}
function requiredString(body: Record<string, unknown>, field: string, min: number, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return value;
}
function optionalString(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return value;
}

@Controller('projects')
@UseGuards(AuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('workspaceId') workspaceId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    if (!workspaceId) throw new BadRequestException('WORKSPACE_ID_REQUIRED');
    let limit = 25;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) throw new BadRequestException('INVALID_LIMIT');
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) throw new BadRequestException('INVALID_LIMIT');
    }
    return this.projects.list(request.user.id, workspaceId, cursor, limit);
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    const body = parseBody(raw);
    rejectUnknown(body, ['workspaceId', 'name', 'summary', 'startMode', 'locale']);
    const workspaceId = requiredString(body, 'workspaceId', 36, 36);
    const name = requiredString(body, 'name', 1, 120);
    const summary = optionalString(body, 'summary', 4000);
    const startMode = body.startMode;
    const locale = body.locale;
    if (!startModes.includes(startMode as (typeof startModes)[number])) throw new BadRequestException('INVALID_START_MODE');
    if (!locales.includes(locale as (typeof locales)[number])) throw new BadRequestException('INVALID_LOCALE');
    return this.projects.create(request.user.id, {
      workspaceId,
      name,
      summary,
      startMode: startMode as (typeof startModes)[number],
      locale: locale as (typeof locales)[number],
    });
  }

  @Get(':projectId')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.get(request.user.id, projectId);
  }
}
