import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { JourneyService } from './journey.service.js';
import { SpecialistsService, type SpecialistTerms } from './specialists.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { WorktimeService } from './worktime.service.js';

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

function whole(value: unknown, field: string, min: number, max: number, optional: boolean): number | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return value;
}
/** Payment terms for a specialist; amounts are whole tenge. */
function termsInput(input: Record<string, unknown>): SpecialistTerms {
  const payKind = input.payKind ?? 'none';
  if (payKind !== 'none' && payKind !== 'fixed' && payKind !== 'hourly') throw new BadRequestException('INVALID_PAYKIND');
  if (input.onlyResultTime !== undefined && typeof input.onlyResultTime !== 'boolean') throw new BadRequestException('INVALID_ONLYRESULTTIME');
  return {
    payKind,
    fixedAmount: whole(input.fixedAmount, 'fixedAmount', 1000, 100_000_000, payKind !== 'fixed'),
    hourlyRate: whole(input.hourlyRate, 'hourlyRate', 500, 1_000_000, payKind !== 'hourly'),
    hourLimit: whole(input.hourLimit, 'hourLimit', 1, 1000, payKind !== 'hourly'),
    weeklyHourLimit: whole(input.weeklyHourLimit, 'weeklyHourLimit', 1, 80, true),
    revisionsIncluded: whole(input.revisionsIncluded, 'revisionsIncluded', 0, 20, true),
    onlyResultTime: input.onlyResultTime === true,
  };
}
function uuid(value: string, code: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException(code);
  return value;
}

@Controller()
@UseGuards(AuthGuard)
export class JourneyController {
  constructor(private readonly journey: JourneyService, private readonly specialists: SpecialistsService, private readonly worktime: WorktimeService, private readonly specialistCatalog: CatalogService) {}

  @Post('projects/:projectId/stages/:stageKey/activity')
  @HttpCode(200)
  activity(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.worktime.heartbeat(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), stageKey(key));
  }

  @Get('projects/:projectId/stages/:stageKey/timesheet')
  timesheet(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.worktime.timesheet(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), stageKey(key));
  }

  @Post('projects/:projectId/stages/:stageKey/timesheet/entries')
  addTime(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['date', 'minutes', 'note']);
    const date = typeof input.date === 'string' ? new Date(input.date) : new Date(NaN);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('INVALID_DATE');
    return this.worktime.addManual(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), stageKey(key), { date, minutes: whole(input.minutes, 'minutes', 5, 600, false)!, note: text(input.note, 'note', 5, 500)! });
  }

  @Post('projects/:projectId/time-entries/:entryId')
  @HttpCode(200)
  decideTime(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('entryId') entryId: string, @Body() raw: unknown) {
    const input = body(raw, ['action', 'comment']);
    const id = uuid(entryId, 'INVALID_ENTRY_ID');
    if (input.action === 'reply') return this.worktime.replyToDispute(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), id, text(input.comment, 'comment', 2, 500)!);
    if (input.action !== 'approve' && input.action !== 'dispute') throw new BadRequestException('INVALID_ACTION');
    return this.worktime.decideEntry(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), id, input.action === 'approve' ? 'approved' : 'disputed', text(input.comment, 'comment', 2, 500, true));
  }

  @Post('projects/:projectId/payments/:paymentId/mark-paid')
  @HttpCode(200)
  markPaid(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('paymentId') paymentId: string) {
    return this.worktime.markPaid(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), uuid(paymentId, 'INVALID_PAYMENT_ID'));
  }

  @Post('projects/:projectId/stages/:stageKey/submit')
  @HttpCode(200)
  submit(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['versionId']);
    return this.journey.submit(request.user.id, projectId, stageKey(key), text(input.versionId, 'versionId', 36, 36)!);
  }

  @Post('projects/:projectId/stages/:stageKey/request-changes')
  @HttpCode(200)
  requestChanges(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['note']);
    return this.journey.requestChanges(request.user.id, projectId, stageKey(key), text(input.note, 'note', 2, 1000)!);
  }

  @Post('projects/:projectId/stages/:stageKey/suggestions')
  suggest(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['text', 'targetKey']);
    return this.journey.suggest(request.user.id, projectId, stageKey(key), { text: text(input.text, 'text', 2, 1000)!, targetKey: text(input.targetKey, 'targetKey', 1, 60, true) });
  }

  @Post('projects/:projectId/stages/:stageKey/suggestions/:suggestionId/:action')
  @HttpCode(200)
  resolveSuggestion(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('suggestionId') suggestionId: string, @Param('action') action: string) {
    if (action !== 'apply' && action !== 'dismiss') throw new BadRequestException('INVALID_ACTION');
    return this.journey.resolveSuggestion(request.user.id, projectId, stageKey(key), suggestionId, action);
  }

  @Get('projects/:projectId/stages/:stageKey/assignments')
  assignments(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.specialists.list(request.user.id, projectId, stageKey(key));
  }

  @Post('projects/:projectId/stages/:stageKey/assignments')
  async invite(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['email', 'profileId', 'role', 'aiBudget', 'payKind', 'fixedAmount', 'hourlyRate', 'hourLimit', 'weeklyHourLimit', 'revisionsIncluded', 'onlyResultTime']);
    // From the catalog the owner picks a profile; the address stays on the server and is never shown in the catalog.
    if ((input.email === undefined) === (input.profileId === undefined)) throw new BadRequestException('INVITE_EMAIL_OR_PROFILE');
    const email = input.profileId !== undefined ? await this.specialistCatalog.emailForInvite(String(input.profileId)) : text(input.email, 'email', 3, 254)!;
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new BadRequestException('INVALID_EMAIL');
    if (input.role !== 'lead' && input.role !== 'consultant') throw new BadRequestException('INVALID_ROLE');
    const aiBudget = input.aiBudget ?? null;
    if (aiBudget !== null && (!Number.isInteger(aiBudget) || (aiBudget as number) < 0 || (aiBudget as number) > 1000)) throw new BadRequestException('INVALID_AIBUDGET');
    return this.specialists.invite(request.user.id, projectId, stageKey(key), { email, role: input.role, aiBudget: aiBudget as number | null, terms: termsInput(input) });
  }

  @Post('projects/:projectId/assignments/:assignmentId/revoke')
  @HttpCode(204)
  async revoke(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('assignmentId') assignmentId: string) {
    await this.specialists.revoke(request.user.id, projectId, assignmentId);
  }

  @Post('invites/:token/accept')
  @HttpCode(200)
  acceptInvite(@Req() request: AuthenticatedRequest, @Param('token') token: string) {
    return this.specialists.accept(request.user.id, request.user.email, token);
  }

  @Get('me/assignments')
  myAssignments(@Req() request: AuthenticatedRequest) {
    return this.specialists.mine(request.user.id);
  }

  @Get('journey/catalog')
  catalog() { return this.journey.catalog(); }

  @Get('projects/:projectId/journey')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.journey(request.user.id, projectId);
  }

  @Get('projects/:projectId/ai-history')
  aiHistory(
    @Req() request: AuthenticatedRequest, @Param('projectId') projectId: string,
    @Query('stageKey') stage?: string, @Query('authorId') authorId?: string, @Query('q') query?: string, @Query('before') before?: string, @Query('limit') limit?: string,
  ) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if (authorId && !uuid.test(authorId)) throw new BadRequestException('INVALID_AUTHOR');
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) throw new BadRequestException('INVALID_CURSOR');
    const size = limit ? Number(limit) : 30;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new BadRequestException('INVALID_LIMIT');
    const q = query?.trim() ? query.trim().slice(0, 200) : null;
    return this.journey.aiHistory(request.user.id, projectId, { stageKey: stage ? stageKey(stage) : null, authorId: authorId ?? null, query: q, before: beforeDate, limit: size });
  }

  @Get('projects/:projectId/stages/:stageKey/changes')
  changes(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.journey.changeNotices(request.user.id, projectId, stageKey(key));
  }

  @Post('projects/:projectId/changes/:noticeId/explain')
  @HttpCode(200)
  explainChange(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('noticeId') noticeId: string) {
    return this.journey.explainChange(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), uuid(noticeId, 'INVALID_NOTICE'));
  }

  @Post('projects/:projectId/change-settings')
  @HttpCode(200)
  changeSettings(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['responseDays']);
    return this.journey.setChangeResponseDays(request.user.id, uuid(projectId, 'INVALID_PROJECT_ID'), whole(input.responseDays, 'responseDays', 1, 14, false)!);
  }

  @Post('projects/:projectId/changes/:noticeId')
  @HttpCode(200)
  actOnChange(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('noticeId') noticeId: string, @Body() raw: unknown) {
    if (!/^[0-9a-f-]{36}$/i.test(noticeId)) throw new BadRequestException('INVALID_NOTICE');
    const input = body(raw, ['action', 'text', 'resolution']);
    const action = input.action;
    if (action !== 'accept' && action !== 'accept_no_change' && action !== 'discuss' && action !== 'reply') throw new BadRequestException('INVALID_ACTION');
    const resolution = input.resolution === undefined || input.resolution === null ? null : input.resolution;
    if (resolution !== null && resolution !== 'kept' && resolution !== 'will_revise' && resolution !== 'escalate') throw new BadRequestException('INVALID_RESOLUTION');
    return this.journey.actOnChange(request.user.id, projectId, noticeId, { action, text: text(input.text, 'text', 1, 2000, true), resolution });
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

  @Post('projects/:projectId/stages/:stageKey/approve')
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['versionId', 'comment']);
    return this.journey.approve(request.user.id, projectId, stageKey(key), text(input.versionId, 'versionId', 36, 36)!, text(input.comment, 'comment', 1, 1000, true));
  }

  @Put('projects/:projectId/stages/:stageKey/approval-policy')
  approvalPolicy(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['policy']);
    if (input.policy !== null && (typeof input.policy !== 'object' || Array.isArray(input.policy))) throw new BadRequestException('INVALID_POLICY');
    const policy = input.policy === null ? null : body(input.policy, ['mode', 'reviewers', 'quorum', 'authorMayApprove']);
    return this.journey.setApprovalPolicy(request.user.id, projectId, stageKey(key), policy ? { mode: policy.mode, reviewers: policy.reviewers, quorum: policy.quorum ?? null, authorMayApprove: policy.authorMayApprove ?? false } : null);
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

  @Post('projects/:projectId/handoff')
  handoff(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.buildHandoff(request.user.id, projectId);
  }

  @Get('projects/:projectId/prototype')
  prototype(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('screen') screen?: string) {
    return this.journey.prototype(request.user.id, projectId, typeof screen === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(screen) ? screen : null);
  }

  @Get('projects/:projectId/preview')
  preview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('versionId') versionId?: string, @Query('page') page?: string) {
    return this.journey.preview(request.user.id, projectId, versionId ?? null, typeof page === 'string' && /^\/[a-z0-9-]{0,30}$/.test(page) ? page : null);
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

  @Post('projects/:projectId/archive')
  @HttpCode(200)
  archive(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'archive');
  }

  @Post('projects/:projectId/unarchive')
  @HttpCode(200)
  unarchive(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'unarchive');
  }

  @Post('projects/:projectId/resume')
  @HttpCode(200)
  resume(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'resume');
  }
}

/** Invitation details are readable without a session so the invitee can see what they are joining before signing in. */
@Controller()
export class InviteInfoController {
  constructor(private readonly specialists: SpecialistsService) {}

  @Get('invites/:token')
  info(@Param('token') token: string) {
    return this.specialists.inviteInfo(token);
  }
}
