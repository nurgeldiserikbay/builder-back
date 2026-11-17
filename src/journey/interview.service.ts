// «Разговор» on a form stage: stores the conversation, asks the next question (AI or the form's own questions) and turns
// the answers into a stage version the owner checks before accepting (STAGE_WORK_MODEL §70).
import { BadGatewayException, BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { costOf } from '../budget/budget.js';
import { tr } from '../i18n/i18n.js';
import { emptyBrief, mergeProposal, normalizeArtifact } from './artifacts.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { JourneyCore, inProject, notEditableCode } from './journey-core.js';
import { StageAiError } from './stage-ai.js';
import { canEdit } from './stage-state.js';
import { WorktimeService } from './worktime.service.js';
import {
  INTERVIEW_LIMITS, INTERVIEW_STAGES, INTERVIEW_VERSION, applyExtracted, buildInterviewPrompt, cleanExtracted, greeting, mergeExtracted, missingRequired, readAiTurn, templateTurn,
  type Extracted, type InterviewMessage,
} from './interview.js';

type Row = { id: string; mode: string; messages: unknown; extracted: unknown; pendingField: string | null; asked: string[]; done: boolean; appliedVersionId: string | null; updatedAt: Date };

@Injectable()
export class InterviewService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly worktime: WorktimeService) {}

  private stageKeyOf(key: string): (typeof INTERVIEW_STAGES)[number] {
    if (!(INTERVIEW_STAGES as readonly string[]).includes(key)) throw new NotFoundException('INTERVIEW_NOT_AVAILABLE');
    return key as (typeof INTERVIEW_STAGES)[number];
  }

  private view(row: Row | null, fields: { key: string; required: boolean }[], aiConfigured: boolean) {
    const extracted = (row?.extracted ?? {}) as Extracted;
    return {
      data: {
        version: INTERVIEW_VERSION,
        mode: row?.mode ?? (aiConfigured ? 'ai' : 'template'),
        messages: (row?.messages ?? []) as InterviewMessage[],
        extracted,
        filled: fields.filter((field) => extracted[field.key] !== undefined).map((field) => field.key),
        missingRequired: missingRequired(fields as never, extracted),
        done: row?.done ?? false,
        applied: Boolean(row?.appliedVersionId),
        turnsLeft: Math.max(0, INTERVIEW_LIMITS.turns - ((row?.messages as unknown[] | undefined)?.length ?? 0)),
      },
    };
  }

  async get(userId: string, projectId: string, key: string) {
    const stageKey = this.stageKeyOf(key);
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const row = await this.prisma.stageInterview.findUnique({ where: { stageId: stage.id } });
    return this.view(row, stageDefinitions[stageKey].fields ?? [], Boolean(this.core.ai()));
  }

  /**
   * Starts the conversation (message null) or answers the owner's message. An AI turn holds the project's AI money like any
   * other request and records its cost; the greeting and the questions without AI cost nothing.
   */
  async say(userId: string, projectId: string, key: string, input: { message: string | null; restart: boolean }) {
    this.stageKeyOf(key);
    const ai = this.core.ai();
    if (ai && input.message !== null) {
      await this.core.load(userId, projectId, 'write', key);
      return this.core.oneAiRequest(projectId, () => this.sayNow(userId, projectId, key, input));
    }
    return this.sayNow(userId, projectId, key, input);
  }

  private async sayNow(userId: string, projectId: string, key: string, input: { message: string | null; restart: boolean }) {
    const stageKey = this.stageKeyOf(key);
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    const definition = stageDefinitions[stageKey as StageKey];
    const fields = definition.fields ?? [];
    const provider = this.core.ai();
    const mode = provider ? 'ai' : 'template';
    let row: Row | null = await this.prisma.stageInterview.findUnique({ where: { stageId: stage.id } });
    if (input.restart && row) { await this.prisma.stageInterview.delete({ where: { id: row.id } }); row = null; }
    const now = () => new Date().toISOString();

    if (!row) {
      // The conversation opens with a greeting (and, without AI, the first question); the story from the project wizard is offered.
      const story = stageKey === 'goal' ? (await this.prisma.project.findUnique({ where: { id: projectId }, select: { summary: true } }))?.summary ?? null : null;
      const messages: InterviewMessage[] = [{ role: 'assistant', text: inProject(ctx, () => greeting(definition, mode === 'ai', story)), at: now() }];
      let pendingField: string | null = null; let asked: string[] = [];
      if (mode === 'template') {
        const first = inProject(ctx, () => templateTurn(fields, {}, null, null, []));
        messages.push({ role: 'assistant', text: first.reply, at: now(), field: first.pendingField });
        pendingField = first.pendingField; asked = first.pendingField ? [first.pendingField] : [];
      }
      const created = await this.prisma.stageInterview.create({ data: { projectId, stageId: stage.id, mode, messages: messages as never, extracted: {}, pendingField, asked, createdByUserId: userId } });
      await this.core.event(this.prisma, projectId, userId, 'interview_started', key, { mode });
      if (input.message === null) return this.view(created, fields, Boolean(provider));
      row = created;
    }
    if (input.message === null) return this.view(row, fields, Boolean(provider));

    const messages = [...(row.messages as InterviewMessage[])];
    if (messages.length + 2 > INTERVIEW_LIMITS.turns) throw new HttpException('INTERVIEW_TOO_LONG', HttpStatus.TOO_MANY_REQUESTS);
    const message = input.message.trim().slice(0, INTERVIEW_LIMITS.message);
    messages.push({ role: 'owner', text: message, at: now() });
    const known = row.extracted as Extracted;

    if (row.mode === 'template' || !provider) {
      const turn = inProject(ctx, () => templateTurn(fields, known, row!.pendingField, message, row!.asked));
      messages.push({ role: 'assistant', text: turn.reply, at: now(), field: turn.pendingField });
      const updated = await this.prisma.stageInterview.update({ where: { id: row.id }, data: {
        messages: messages as never, extracted: turn.extracted as never, pendingField: turn.pendingField, done: turn.done,
        asked: turn.pendingField && !row.asked.includes(turn.pendingField) ? [...row.asked, turn.pendingField] : row.asked,
      } });
      await this.worktime.recordAction(userId, projectId, key);
      return this.view(updated, fields, Boolean(provider));
    }

    if (await this.core.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    const assignment = this.core.assignmentFor(ctx, key);
    if (assignment && assignment.aiBudget !== null && assignment.aiUsed >= assignment.aiBudget) throw new HttpException('AI_BUDGET_EXHAUSTED', HttpStatus.TOO_MANY_REQUESTS);
    const inputs = await this.core.viewInputs(ctx, stageKey as StageKey);
    const prompt = buildInterviewPrompt({
      stage: definition, locale: ctx.project.locale, projectTypeTitle: ctx.type.title, known, messages,
      confirmedInputs: Object.fromEntries(Object.entries(inputs).map(([inputKey, value]) => [inputKey, value.content])),
    });
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    const started = Date.now();
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const record = (status: 'succeeded' | 'failed', code: string | null) => this.prisma.generationRun.create({ data: {
      projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: definition.playbook.version,
      targetKey: 'interview', inputVersionIds: Object.values(inputs).map((item) => item.versionId), baseVersionId: stage.currentVersionId, status, safeErrorCode: code,
      durationMs: Date.now() - started, source: 'app', inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
    } });
    let turn: { reply: string; extracted: Extracted; done: boolean };
    try {
      const detailed = provider.generateDetailed ? await provider.generateDetailed(prompt) : { output: await provider.generate(prompt), usage: null };
      usage = detailed.usage;
      turn = readAiTurn(fields, detailed.output);
    } catch (error) {
      const code = error instanceof StageAiError ? error.code : 'AI_OUTPUT_REJECTED';
      await record('failed', code);
      if (code === 'AI_OUTPUT_REJECTED') throw new BadGatewayException(code);
      throw new ServiceUnavailableException(code);
    }
    const extracted = mergeExtracted(known, turn.extracted);
    messages.push({ role: 'assistant', text: turn.reply, at: now() });
    const [updated] = await this.prisma.$transaction([
      this.prisma.stageInterview.update({ where: { id: row.id }, data: { messages: messages as never, extracted: extracted as never, done: turn.done && missingRequired(fields, extracted).length === 0 } }),
      ...(assignment ? [this.prisma.stageAssignment.update({ where: { id: assignment.id }, data: { aiUsed: { increment: 1 } } })] : []),
    ]);
    await record('succeeded', null);
    await this.worktime.recordAction(userId, projectId, key);
    return this.view(updated, fields, true);
  }

  /** Fills the stage form from the conversation: a new version on top of the current one; fields a person locked stay. */
  async apply(userId: string, projectId: string, key: string) {
    const stageKey = this.stageKeyOf(key);
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    const row = await this.prisma.stageInterview.findUnique({ where: { stageId: stage.id } });
    if (!row) throw new NotFoundException('INTERVIEW_NOT_STARTED');
    const definition = stageDefinitions[stageKey as StageKey];
    const extracted = cleanExtracted(definition.fields ?? [], row.extracted);
    if (!Object.keys(extracted).length) throw new BadRequestException('INTERVIEW_NOTHING_TO_APPLY');
    const base = await this.core.versionContent(stage.currentVersionId);
    const empty = stageKey === 'goal' ? emptyBrief() : { services: [], hours: null };
    const proposal = applyExtracted((base?.content ?? empty) as Record<string, unknown>, extracted);
    // A field a person filled in and locked stays; an empty field counts as not written, so the conversation may fill it.
    const baseValues = (base?.content ?? {}) as Record<string, unknown>;
    const filled = (value: unknown) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
    const locked = stage.lockedKeys.filter((lockKey) => filled(baseValues[lockKey]));
    const content = inProject(ctx, () => normalizeArtifact(definition.artifactType, mergeProposal(definition.artifactType, base?.content ?? null, normalizeArtifact(definition.artifactType, proposal), locked, null)));
    const version = await this.prisma.$transaction(async (tx) => {
      const created = await this.core.createVersion(tx, {
        projectId, stage, artifactType: definition.artifactType, content, origin: row.mode === 'ai' ? 'ai_generated' : 'template',
        note: inProject(ctx, () => tr('Из разговора')), userId,
      });
      await tx.stageInterview.update({ where: { id: row.id }, data: { appliedVersionId: created.id } });
      await this.core.event(tx, projectId, userId, 'interview_applied', key, { versionNumber: created.versionNumber, fields: Object.keys(extracted), mode: row.mode });
      return created;
    });
    await this.worktime.recordAction(userId, projectId, key);
    return { data: { versionId: version.id, versionNumber: version.versionNumber } };
  }
}
