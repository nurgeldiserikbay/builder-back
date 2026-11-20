// «Разговор» on a form stage: stores the conversation, asks the next question (AI or the form's own questions) and turns
// the answers into a stage version the owner checks before accepting (STAGE_WORK_MODEL §70).
import { BadGatewayException, BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { costOf } from '../budget/budget.js';
import { tr } from '../i18n/i18n.js';
import { emptyBrief, mergeProposal, normalizeArtifact } from './artifacts.js';
import { stageFor, type StageKey } from './catalog.js';
import { JourneyCore, inProject, notEditableCode } from './journey-core.js';
import { StageAiError } from './stage-ai.js';
import { canEdit } from './stage-state.js';
import { WorktimeService } from './worktime.service.js';
import { StageAiService } from './stage-ai.service.js';
import { transcribe, transcribeConfig, VOICE_LIMITS } from '../telegram-bot/transcribe.js';
import {
  COMPOSED_STAGES, INTERVIEW_LIMITS, INTERVIEW_STAGES, conversationMaterial, interviewFields, INTERVIEW_VERSION, applyExtracted, buildInterviewPrompt, cleanExtracted, greeting, mergeExtracted, missingRequired, readAiTurn, templateTurn,
  type Extracted, type InterviewMessage,
} from './interview.js';

/** What browsers record: Chrome and Firefox webm/ogg with Opus, Safari mp4/AAC. The name tells the service the format. */
const VOICE_FORMATS: Record<string, { mime: string; name: string }> = {
  'audio/webm': { mime: 'audio/webm', name: 'voice.webm' }, 'audio/ogg': { mime: 'audio/ogg', name: 'voice.ogg' },
  'audio/mp4': { mime: 'audio/mp4', name: 'voice.mp4' }, 'audio/x-m4a': { mime: 'audio/mp4', name: 'voice.m4a' }, 'audio/aac': { mime: 'audio/aac', name: 'voice.aac' },
  'audio/mpeg': { mime: 'audio/mpeg', name: 'voice.mp3' }, 'audio/wav': { mime: 'audio/wav', name: 'voice.wav' },
};

type Row = { id: string; mode: string; messages: unknown; extracted: unknown; pendingField: string | null; asked: string[]; done: boolean; appliedVersionId: string | null; updatedAt: Date };

@Injectable()
export class InterviewService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly worktime: WorktimeService, private readonly stageAi: StageAiService) {}

  private stageKeyOf(key: string): (typeof INTERVIEW_STAGES)[number] {
    if (!(INTERVIEW_STAGES as readonly string[]).includes(key)) throw new NotFoundException('INTERVIEW_NOT_AVAILABLE');
    return key as (typeof INTERVIEW_STAGES)[number];
  }

  private view(row: Row | null, fields: { key: string; label: string; required: boolean }[], aiConfigured: boolean, composed = false) {
    const extracted = (row?.extracted ?? {}) as Extracted;
    return {
      data: {
        version: INTERVIEW_VERSION,
        // On process and the ТЗ the AI composes the stage from the answers: without AI the conversation is not offered.
        composed, available: !composed || aiConfigured,
        // What the conversation asks about: the form's fields or, on composed stages, its topics.
        topics: fields.map((field) => ({ key: field.key, label: tr(field.label), required: field.required })),
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
    const view = this.view(row, interviewFields(stageFor(stageKey, ctx.type.key)), Boolean(this.core.ai()), COMPOSED_STAGES.includes(stageKey));
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { voiceConsentAt: true } });
    const config = transcribeConfig();
    // The consent names where the recording goes: the host of the connected recognition service.
    return { data: { ...view.data, voice: { available: Boolean(config), consented: Boolean(user?.voiceConsentAt), maxSeconds: VOICE_LIMITS.seconds, service: config ? new URL(config.baseUrl).hostname : null } } };
  }

  /**
   * A voice answer: the recording goes once to the speech recognition service and is not stored; the owner gets the text to
   * check and send. The same consent and daily limit as voice messages in the Telegram bot.
   */
  async voice(userId: string, projectId: string, key: string, file: { buffer: Buffer; mimetype: string; size: number } | undefined, consent: boolean) {
    const stageKey = this.stageKeyOf(key);
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    const config = transcribeConfig();
    if (!config) throw new ServiceUnavailableException('VOICE_NOT_CONFIGURED');
    if (!file || !file.size) throw new BadRequestException('VOICE_REQUIRED');
    if (file.size > VOICE_LIMITS.bytes) throw new BadRequestException('VOICE_TOO_LONG');
    const format = VOICE_FORMATS[file.mimetype.split(';')[0]!.trim().toLowerCase()];
    if (!format) throw new BadRequestException('VOICE_FORMAT_NOT_SUPPORTED');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { voiceConsentAt: true, locale: true } });
    if (!user.voiceConsentAt) {
      if (!consent) throw new ConflictException('VOICE_CONSENT_REQUIRED');
      await this.prisma.user.update({ where: { id: userId }, data: { voiceConsentAt: new Date() } });
      await this.core.event(this.prisma, projectId, userId, 'voice_consent_given', stageKey, { source: 'app' });
    }
    const today = await this.prisma.projectEvent.count({ where: { actorUserId: userId, type: 'voice_transcribed', createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (today >= VOICE_LIMITS.perDay) throw new HttpException('VOICE_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    const language = ctx.project.locale === 'en' ? 'en' : ctx.project.locale === 'kk' ? 'kk' : 'ru';
    const text = await transcribe(config, file.buffer, language, fetch, format);
    if (!text) throw new HttpException('VOICE_NOT_RECOGNISED', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.core.event(this.prisma, projectId, userId, 'voice_transcribed', stageKey, { kind: 'interview', characters: text.length, source: 'app' });
    return { data: { text: text.slice(0, INTERVIEW_LIMITS.message) } };
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
    const definition = stageFor(stageKey as StageKey, ctx.type.key);
    const fields = interviewFields(definition);
    const provider = this.core.ai();
    const composed = COMPOSED_STAGES.includes(stageKey);
    if (composed && !provider) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
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
      if (input.message === null) return this.view(created, fields, Boolean(provider), composed);
      row = created;
    }
    if (input.message === null) return this.view(row, fields, Boolean(provider), composed);

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
      return this.view(updated, fields, Boolean(provider), composed);
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
    return this.view(updated, fields, true, composed);
  }

  /** Fills the stage form from the conversation: a new version on top of the current one; fields a person locked stay. */
  async apply(userId: string, projectId: string, key: string) {
    const stageKey = this.stageKeyOf(key);
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    if (!canEdit(stage.status)) throw new ConflictException(notEditableCode(stage.status));
    const row = await this.prisma.stageInterview.findUnique({ where: { stageId: stage.id } });
    if (!row) throw new NotFoundException('INTERVIEW_NOT_STARTED');
    const definition = stageFor(stageKey as StageKey, ctx.type.key);
    const extracted = cleanExtracted(interviewFields(definition), row.extracted);
    if (!Object.keys(extracted).length) throw new BadRequestException('INTERVIEW_NOTHING_TO_APPLY');
    if (COMPOSED_STAGES.includes(stageKey)) {
      // The AI composes the stage from the answers, with the same rules, checks and costs as any draft on this stage.
      const material = inProject(ctx, () => conversationMaterial(definition, extracted));
      const result = await this.stageAi.generate(userId, projectId, key, { instruction: inProject(ctx, () => tr('Составить по разговору с владельцем')), saveAs: 'one_off', targetKey: null, conversation: material });
      await this.prisma.stageInterview.update({ where: { id: row.id }, data: { appliedVersionId: result.data.versionId } });
      await this.core.event(this.prisma, projectId, userId, 'interview_applied', key, { versionNumber: result.data.versionNumber, fields: Object.keys(extracted), mode: row.mode, composed: true });
      return { data: { versionId: result.data.versionId, versionNumber: result.data.versionNumber } };
    }
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
