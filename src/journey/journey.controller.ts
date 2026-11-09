import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { JourneyService } from './journey.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !fields.includes(field))) throw new BadRequestException('UNKNOWN_FIELD');
  return record;
}
function text(value: unknown, field: string, min: number, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return value.trim();
}
function stageKey(value: string): string {
  if (!/^[a-z]{2,20}$/.test(value)) throw new BadRequestException('INVALID_STAGE_KEY');
  return value;
}

@Controller()
@UseGuards(AuthGuard)
export class JourneyController {
  constructor(private readonly journey: JourneyService) {}

  @Get('journey/catalog')
  catalog() { return this.journey.catalog(); }

  @Get('projects/:projectId/journey')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.journey(request.user.id, projectId);
  }

  @Get('projects/:projectId/stages/:stageKey')
  stage(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.journey.stage(request.user.id, projectId, stageKey(key));
  }

  @Put('projects/:projectId/stages/:stageKey/draft')
  saveDraft(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['content', 'baseVersionId']);
    if (JSON.stringify(input.content ?? null).length > 60_000) throw new BadRequestException('CONTENT_TOO_LARGE');
    return this.journey.saveDraft(request.user.id, projectId, stageKey(key), { content: input.content, baseVersionId: text(input.baseVersionId, 'baseVersionId', 36, 36, true) });
  }

  @Post('projects/:projectId/stages/:stageKey/generate')
  @HttpCode(200)
  generate(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw ?? {}, ['instruction', 'saveAs', 'targetKey']);
    const saveAs = input.saveAs ?? 'one_off';
    if (!['one_off', 'stage_rule', 'project_rule'].includes(saveAs as string)) throw new BadRequestException('INVALID_SAVEAS');
    const instruction = text(input.instruction, 'instruction', 2, 1000, true);
    if (saveAs !== 'one_off' && !instruction) throw new BadRequestException('INSTRUCTION_REQUIRED');
    return this.journey.generate(request.user.id, projectId, stageKey(key), {
      instruction, saveAs: saveAs as 'one_off' | 'stage_rule' | 'project_rule', targetKey: text(input.targetKey, 'targetKey', 1, 60, true),
    });
  }

  @Post('projects/:projectId/stages/:stageKey/locks')
  @HttpCode(200)
  lock(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['key', 'locked']);
    if (typeof input.locked !== 'boolean') throw new BadRequestException('INVALID_LOCKED');
    return this.journey.setLock(request.user.id, projectId, stageKey(key), text(input.key, 'key', 1, 60)!, input.locked);
  }

  @Post('projects/:projectId/stages/:stageKey/rules')
  addRule(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['text', 'scope']);
    if (input.scope !== 'stage_rule' && input.scope !== 'project_rule') throw new BadRequestException('INVALID_SCOPE');
    return this.journey.addRule(request.user.id, projectId, stageKey(key), { text: text(input.text, 'text', 2, 1000)!, scope: input.scope });
  }

  @Post('projects/:projectId/rules/:ruleId/status')
  @HttpCode(200)
  ruleStatus(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('ruleId') ruleId: string, @Body() raw: unknown) {
    const input = body(raw, ['status']);
    if (input.status !== 'active' && input.status !== 'disabled') throw new BadRequestException('INVALID_STATUS');
    return this.journey.setRuleStatus(request.user.id, projectId, ruleId, input.status);
  }

  @Post('projects/:projectId/stages/:stageKey/versions/:versionId/restore')
  restore(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('versionId') versionId: string) {
    return this.journey.restore(request.user.id, projectId, stageKey(key), versionId);
  }

  @Post('projects/:projectId/stages/:stageKey/import')
  importText(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['text']);
    return this.journey.importText(request.user.id, projectId, stageKey(key), text(input.text, 'text', 2, 20_000)!);
  }

  @Post('projects/:projectId/stages/:stageKey/accept')
  @HttpCode(200)
  accept(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['versionId']);
    return this.journey.accept(request.user.id, projectId, stageKey(key), text(input.versionId, 'versionId', 36, 36)!);
  }

  @Post('projects/:projectId/stages/:stageKey/reopen')
  @HttpCode(200)
  reopen(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.journey.reopen(request.user.id, projectId, stageKey(key));
  }

  @Post('projects/:projectId/build')
  build(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.build(request.user.id, projectId);
  }

  @Get('projects/:projectId/preview')
  preview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('versionId') versionId?: string) {
    return this.journey.preview(request.user.id, projectId, versionId ?? null);
  }

  @Get('projects/:projectId/result')
  result(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.result(request.user.id, projectId);
  }

  @Post('projects/:projectId/complete')
  @HttpCode(200)
  complete(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'complete');
  }

  @Post('projects/:projectId/resume')
  @HttpCode(200)
  resume(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'resume');
  }
}
