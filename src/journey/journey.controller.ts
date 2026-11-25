import { RoadmapProgressService } from './roadmap-progress.service.js';
import { CommentsService } from './comments.service.js';
import { StageReviewService } from './stage-review.service.js';
import { BadRequestException, NotFoundException, Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VOICE_LIMITS } from '../telegram-bot/transcribe.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { JourneyService } from './journey.service.js';
import { SpecialistsService, type SpecialistTerms } from './specialists.service.js';
import { ChangeProposalsService } from './change-proposals.service.js';
import { InterviewService } from './interview.service.js';
import { PlaybooksService } from './playbooks.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { WorktimeService } from './worktime.service.js';

import { attachment } from '../analysis/analysis.controller.js';

type Download = { set(headers: Record<string, string>): unknown; send(body: Buffer): unknown };
function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !fields.includes(field))) throw new BadRequestException('UNKNOWN_FIELD');
  return record;
}
function findingIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 60 || value.some((item) => typeof item !== 'string' || !/^[A-Z_]{3,60}:[A-Za-z0-9_-]{1,40}(:\d{1,3})?$/.test(item))) throw new BadRequestException('INVALID_FINDING_IDS');
  return value as string[];
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
  constructor(private readonly journey: JourneyService, private readonly specialists: SpecialistsService, private readonly worktime: WorktimeService, private readonly specialistCatalog: CatalogService, private readonly comments: CommentsService, private readonly review: StageReviewService, private readonly proposals: ChangeProposalsService, private readonly playbooks: PlaybooksService, private readonly interviews: InterviewService, private readonly roadmap: RoadmapProgressService) {}

  @Get('projects/:projectId/stages/:stageKey/comments')
  listComments(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.comments.list(request.user.id, projectId, stageKey(key));
  }

  @Post('projects/:projectId/stages/:stageKey/comments')
  addComment(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['text', 'targetKey', 'blocking', 'parentId', 'fileIds', 'mentionUserIds']);
    if (input.blocking !== undefined && typeof input.blocking !== 'boolean') throw new BadRequestException('INVALID_BLOCKING');
    const ids = (value: unknown, code: string) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== 'string')) throw new BadRequestException(code);
      return value as string[];
    };
    return this.comments.add(request.user.id, projectId, stageKey(key), {
      text: text(input.text, 'text', 2, 2000)!, targetKey: text(input.targetKey, 'targetKey', 1, 60, true), blocking: input.blocking === true, parentId: text(input.parentId, 'parentId', 36, 36, true),
      fileIds: ids(input.fileIds, 'COMMENT_FILES_INVALID'), mentionUserIds: ids(input.mentionUserIds, 'COMMENT_MENTIONS_INVALID'),
    });
  }

  @Post('projects/:projectId/stages/:stageKey/comments/:commentId/:action')
  @HttpCode(200)
  resolveComment(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('commentId') commentId: string, @Param('action') action: string) {
    if (action !== 'resolve' && action !== 'reopen') throw new BadRequestException('INVALID_ACTION');
    return this.comments.resolve(request.user.id, projectId, stageKey(key), commentId, action === 'resolve');
  }

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
    const input = body(raw, ['email', 'profileId', 'role', 'aiBudget', 'payKind', 'fixedAmount', 'hourlyRate', 'hourLimit', 'weeklyHourLimit', 'revisionsIncluded', 'onlyResultTime', 'access']);
    // From the catalog the owner picks a profile; the address stays on the server and is never shown in the catalog.
    if ((input.email === undefined) === (input.profileId === undefined)) throw new BadRequestException('INVITE_EMAIL_OR_PROFILE');
    const email = input.profileId !== undefined ? await this.specialistCatalog.emailForInvite(String(input.profileId)) : text(input.email, 'email', 3, 254)!;
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new BadRequestException('INVALID_EMAIL');
    if (input.role !== 'lead' && input.role !== 'consultant') throw new BadRequestException('INVALID_ROLE');
    const aiBudget = input.aiBudget ?? null;
    if (aiBudget !== null && (!Number.isInteger(aiBudget) || (aiBudget as number) < 0 || (aiBudget as number) > 1000)) throw new BadRequestException('INVALID_AIBUDGET');
    return this.specialists.invite(request.user.id, projectId, stageKey(key), { email, role: input.role, aiBudget: aiBudget as number | null, terms: termsInput(input), access: input.access });
  }

  /** What the specialist can see and do: { extraReadStages?, hiddenParts?, allowDownload?, readDays?, editMode? }; applies at once. */
  @Put('projects/:projectId/assignments/:assignmentId/access')
  updateAccess(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('assignmentId') assignmentId: string, @Body() raw: unknown) {
    return this.specialists.updateAccess(request.user.id, projectId, assignmentId, raw);
  }

  /** A specialist proposes to change an accepted input of their stage: { targetStageKey, text }. */
  @Post('projects/:projectId/stages/:stageKey/change-proposals')
  propose(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    return this.proposals.create(request.user.id, projectId, stageKey(key), raw);
  }

  @Get('projects/:projectId/change-proposals')
  listProposals(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.proposals.list(request.user.id, projectId);
  }

  /** { decision: accept | reject, note?, applyWithAi? } — owner or manager. */
  @Post('projects/:projectId/change-proposals/:proposalId/decide')
  @HttpCode(200)
  decideProposal(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('proposalId') proposalId: string, @Body() raw: unknown) {
    return this.proposals.decide(request.user.id, projectId, proposalId, raw);
  }

  @Post('projects/:projectId/change-proposals/:proposalId/withdraw')
  @HttpCode(200)
  withdrawProposal(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('proposalId') proposalId: string) {
    return this.proposals.withdraw(request.user.id, projectId, proposalId);
  }

  /** The specialist's own playbooks — no project data, reusable across projects (STAGE_WORK_MODEL §7.4). */
  @Get('me/playbooks')
  myPlaybooks(@Req() request: AuthenticatedRequest) {
    return this.playbooks.mine(request.user.id);
  }

  @Post('me/playbooks')
  createPlaybook(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.playbooks.create(request.user.id, raw);
  }

  @Put('me/playbooks/:playbookId')
  updatePlaybook(@Req() request: AuthenticatedRequest, @Param('playbookId') playbookId: string, @Body() raw: unknown) {
    return this.playbooks.update(request.user.id, playbookId, raw);
  }

  @Post('me/playbooks/:playbookId/delete')
  @HttpCode(200)
  deletePlaybook(@Req() request: AuthenticatedRequest, @Param('playbookId') playbookId: string) {
    return this.playbooks.remove(request.user.id, playbookId);
  }

  @Get('projects/:projectId/stages/:stageKey/playbook')
  stagePlaybook(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.playbooks.stage(request.user.id, projectId, stageKey(key));
  }

  /** { playbookId } — the stage lead attaches one of their playbooks for this kind of stage. */
  @Put('projects/:projectId/stages/:stageKey/playbook')
  attachPlaybook(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    return this.playbooks.attach(request.user.id, projectId, stageKey(key), raw && typeof raw === 'object' ? (raw as { playbookId?: unknown }).playbookId : undefined);
  }

  @Post('projects/:projectId/stages/:stageKey/playbook/detach')
  @HttpCode(200)
  detachPlaybook(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.playbooks.detach(request.user.id, projectId, stageKey(key));
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

  /** «Расскажите о своём деле»: the kind of project from the description and a few plain questions; no AI, no charge. */
  @Post('journey/type-suggestion')
  @HttpCode(200)
  typeSuggestion(@Body() body: { description?: unknown; answers?: unknown }) {
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) throw new BadRequestException('FIELD_INVALID:description');
    return this.journey.typeSuggestion(typeof body.description === 'string' ? body.description : '', body.answers);
  }

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

  /** «Изменить через ИИ» with a preview: { instruction, targetKey? } → the proposed stage, what changed and what is still missing. */
  @Post('projects/:projectId/stages/:stageKey/ai-proposals')
  @HttpCode(200)
  proposeAiChange(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw ?? {}, ['instruction', 'targetKey']);
    const instruction = text(input.instruction, 'instruction', 2, 1000, false)!;
    return this.journey.proposeChange(request.user.id, projectId, stageKey(key), { instruction, targetKey: text(input.targetKey, 'targetKey', 1, 60, true) });
  }

  @Post('projects/:projectId/stages/:stageKey/ai-proposals/:proposalId/:action')
  @HttpCode(200)
  decideAiProposal(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Param('proposalId') proposalId: string, @Param('action') action: string) {
    if (action === 'apply') return this.journey.applyProposal(request.user.id, projectId, stageKey(key), proposalId);
    if (action === 'dismiss') return this.journey.dismissProposal(request.user.id, projectId, stageKey(key), proposalId);
    throw new NotFoundException('NOT_FOUND');
  }

  @Get('projects/:projectId/stages/:stageKey/interview')
  @Header('Cache-Control', 'no-store')
  interview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.interviews.get(request.user.id, projectId, stageKey(key));
  }

  @Post('projects/:projectId/stages/:stageKey/interview')
  @HttpCode(200)
  interviewSay(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw ?? {}, ['message', 'restart']);
    return this.interviews.say(request.user.id, projectId, stageKey(key), { message: text(input.message, 'message', 1, 1000, true), restart: input.restart === true });
  }

  @Post('projects/:projectId/stages/:stageKey/interview/voice')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VOICE_LIMITS.bytes, files: 1, fields: 1, fieldSize: 10 } }))
  interviewVoice(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined, @Body() raw: Record<string, unknown> | undefined) {
    return this.interviews.voice(request.user.id, projectId, stageKey(key), file, raw?.consent === 'true');
  }

  @Post('projects/:projectId/stages/:stageKey/interview/apply')
  @HttpCode(200)
  interviewApply(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.interviews.apply(request.user.id, projectId, stageKey(key));
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
    const input = body(raw, ['text', 'fileId']);
    // Either pasted text or a document already uploaded to the stage's files (scanned on upload).
    if (typeof input.fileId === 'string') return this.journey.importText(request.user.id, projectId, stageKey(key), { fileId: input.fileId });
    return this.journey.importText(request.user.id, projectId, stageKey(key), { text: text(input.text, 'text', 2, 20_000)! });
  }

  /** The owner explains in writing why the stage moves on although these blocking findings stay. */
  @Post('projects/:projectId/stages/:stageKey/review/override')
  @HttpCode(200)
  overrideReview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['versionId', 'findingIds', 'reason']);
    return this.review.override(request.user.id, projectId, stageKey(key), { versionId: text(input.versionId, 'versionId', 36, 36)!, findingIds: findingIds(input.findingIds), reason: text(input.reason, 'reason', 10, 1000)! });
  }

  /** The AI reviewer looks at the current version and gives advice; advice never blocks acceptance. */
  @Post('projects/:projectId/stages/:stageKey/review/ai')
  @HttpCode(200)
  aiReview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.review.aiReview(request.user.id, projectId, stageKey(key));
  }

  /** The AI fixes the chosen findings and nothing else; the new version is reviewed again. */
  @Post('projects/:projectId/stages/:stageKey/review/fix')
  @HttpCode(200)
  fixReview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const input = body(raw, ['findingIds']);
    return this.review.fix(request.user.id, projectId, stageKey(key), { findingIds: findingIds(input.findingIds) });
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
    const policy = input.policy === null ? null : body(input.policy, ['mode', 'reviewers', 'quorum', 'authorMayApprove', 'order']);
    return this.journey.setApprovalPolicy(request.user.id, projectId, stageKey(key), policy ? { mode: policy.mode, reviewers: policy.reviewers, quorum: policy.quorum ?? null, authorMayApprove: policy.authorMayApprove ?? false, order: policy.order ?? 'parallel' } : null);
  }

  @Post('projects/:projectId/stages/:stageKey/reopen')
  @HttpCode(200)
  reopen(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string) {
    return this.journey.reopen(request.user.id, projectId, stageKey(key));
  }

  /** The product concept as a file: ?format=md or docx. The PDF is the print page of the web app. */
  @Get('projects/:projectId/stages/concept/document')
  async conceptDocument(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('format') format: string | undefined, @Res() response: Download) {
    if (format !== 'md' && format !== 'docx') throw new BadRequestException('INVALID_FORMAT');
    const file = await this.journey.conceptFile(request.user.id, projectId, format);
    response.set({ 'Content-Type': file.mime, 'Content-Disposition': attachment(file.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    response.send(file.data);
  }

  /** { reason } — skip an optional stage; the stages after it go on without it. Owner or manager. */
  /** Progress of the accepted implementation plan: tasks with status, person and date, weighted progress, blocks, finish date. */
  @Get('projects/:projectId/roadmap/progress')
  roadmapProgress(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.roadmap.view(request.user.id, projectId);
  }

  @Put('projects/:projectId/roadmap/tasks/:taskKey')
  updateRoadmapTask(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('taskKey') taskKey: string, @Body() raw: unknown) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(taskKey)) throw new BadRequestException('TASK_NOT_FOUND');
    const input = body(raw ?? {}, ['status', 'note', 'blockedBy', 'assigneeUserId', 'dueDate']);
    return this.roadmap.update(request.user.id, projectId, taskKey, input);
  }

  @Post('projects/:projectId/stages/:stageKey/skip')
  @HttpCode(200)
  skip(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') key: string, @Body() raw: unknown) {
    const reason = text(body(raw ?? {}, ['reason']).reason, 'reason', 10, 500, false)!;
    return this.journey.skip(request.user.id, projectId, stageKey(key), reason);
  }

  @Post('projects/:projectId/build')
  build(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.build(request.user.id, projectId);
  }

  @Post('projects/:projectId/handoff')
  handoff(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.buildHandoff(request.user.id, projectId);
  }

  @Get('projects/:projectId/handoff')
  handoffFiles(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.handoffFiles(request.user.id, projectId);
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

  @Post('projects/:projectId/pause')
  @HttpCode(200)
  pause(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.journey.setProjectStatus(request.user.id, projectId, 'pause');
  }

  /** Optional body: { reason } — why the project is abandoned, kept in the project log. */
  @Post('projects/:projectId/cancel')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const reason = raw && typeof raw === 'object' && typeof (raw as { reason?: unknown }).reason === 'string' ? (raw as { reason: string }).reason : null;
    if (reason !== null && reason.length > 300) throw new BadRequestException('CANCEL_REASON_TOO_LONG');
    return this.journey.setProjectStatus(request.user.id, projectId, 'cancel', reason);
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
