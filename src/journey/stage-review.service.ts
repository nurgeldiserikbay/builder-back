import { BadRequestException, BadGatewayException, ConflictException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { costOf } from '../budget/budget.js';
import { lockableKeys } from './artifacts.js';
import { AI_REVIEW_VERSION, StageAiError, buildReviewPrompt, normalizeAiReview, type AiReviewFinding } from './stage-ai.js';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { JourneyCore } from './journey-core.js';
import { StageAiService } from './stage-ai.service.js';
import { fixInstruction, REVIEW_LIMITS, reviewStage, uncoveredBlocking, type ReviewFinding, type StageReview } from './stage-review.js';

type Ctx = Awaited<ReturnType<JourneyCore['load']>>;

/** Marks AI review requests in the AI history (they change no version). */
export const AI_REVIEW_TARGET = '_review';

/**
 * The quality review of a stage result as people see and act on it: the findings of the deterministic rules, the owner's
 * written explanations for going on despite a blocking one, and «let the AI fix these» for chosen findings.
 */
@Injectable()
export class StageReviewService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly stageAi: StageAiService) {}

  async reviewOf(ctx: Ctx, key: StageKey, content: unknown): Promise<StageReview> {
    const definition = stageDefinitions[key];
    const context = await this.core.checkContext(ctx, key);
    return reviewStage(definition.artifactType, content, context);
  }

  static async overridden(prisma: PrismaService, stageId: string, versionId: string): Promise<string[]> {
    const rows = await prisma.stageReviewOverride.findMany({ where: { stageId, versionId }, select: { findingIds: true } });
    return [...new Set(rows.flatMap((row) => row.findingIds))];
  }

  /** What the stage page shows: the review of the current version with the explanations already given for it. */
  async view(ctx: Ctx, userId: string, projectId: string, key: StageKey, stageId: string, version: { id: string; content: unknown } | null) {
    if (!version) return null;
    const review = await this.reviewOf(ctx, key, version.content);
    const rows = await this.prisma.stageReviewOverride.findMany({ where: { stageId, versionId: version.id }, orderBy: { createdAt: 'asc' } });
    const people = rows.length ? await this.core.historyPeople(ctx, projectId, userId) : new Map<string, { name: string }>();
    const covered = new Set(rows.flatMap((row) => row.findingIds));
    return {
      ...review,
      findings: review.findings.map((finding) => ({ ...finding, overridden: covered.has(finding.id) })),
      uncoveredBlocking: uncoveredBlocking(review, [...covered]).map((finding) => finding.id),
      overrides: rows.map((row) => ({ id: row.id, findingIds: row.findingIds, reason: row.reason, author: people.get(row.authorUserId)?.name ?? tr('Участник'), createdAt: row.createdAt })),
      ai: await this.latestAi(stageId, version.id),
    };
  }

  /** The newest AI advice on this version; advice on older versions is not shown, the result has changed since. */
  private async latestAi(stageId: string, versionId: string) {
    const row = await this.prisma.stageAiReview.findFirst({ where: { stageId, versionId }, orderBy: { createdAt: 'desc' } });
    return row ? { createdAt: row.createdAt, findings: row.findings as unknown as AiReviewFinding[] } : null;
  }

  /**
   * The AI reviewer: one AI request, counted like any other (daily limit, specialist budget, plan, spend limit). Its
   * findings are advice next to the rule findings and never block acceptance.
   */
  async aiReview(userId: string, projectId: string, key: string) {
    const provider = this.core.ai();
    await this.core.load(userId, projectId, 'write', key);
    if (!provider) throw new ServiceUnavailableException('AI_NOT_CONFIGURED');
    return this.core.oneAiRequest(projectId, () => this.aiReviewNow(userId, projectId, key));
  }

  private async aiReviewNow(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const stageKey = key as StageKey;
    const definition = stageDefinitions[stageKey];
    if (definition.artifactType === 'site' || definition.artifactType === 'handoff') throw new BadRequestException('AI_REVIEW_NOT_USED_FOR_STAGE');
    const version = await this.core.versionContent(stage.currentVersionId);
    if (!version) throw new ConflictException('NOTHING_TO_REVIEW');
    const provider = this.core.ai()!;
    const assignment = this.core.assignmentFor(ctx, key);
    if (await this.core.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    if (assignment && assignment.aiBudget !== null && assignment.aiUsed >= assignment.aiBudget) throw new HttpException('AI_BUDGET_EXHAUSTED', HttpStatus.TOO_MANY_REQUESTS);
    const inputs = await this.core.acceptedInputs(ctx, stageKey);
    const rules = await this.reviewOf(ctx, stageKey, version.content);
    const targets = lockableKeys(definition.artifactType, version.content);
    const prompt = buildReviewPrompt({
      stage: definition, locale: ctx.project.locale, projectTypeTitle: ctx.type.title, current: version.content, targets,
      inputs: Object.fromEntries(Object.entries(inputs).map(([inputKey, value]) => [inputKey, value.content])),
      ruleFindings: rules.findings.map((finding) => `${finding.where}: ${finding.message}`),
    });
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    const started = Date.now();
    const runData = (usage: { inputTokens: number | null; outputTokens: number | null } | null) => ({
      projectId, stageId: stage.id, requestedByUserId: userId, provider: provider.name, model: provider.model, playbookVersion: `review-${AI_REVIEW_VERSION}`,
      targetKey: AI_REVIEW_TARGET, inputVersionIds: Object.values(inputs).map((item) => item.versionId), baseVersionId: version.id,
      durationMs: Date.now() - started, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, costTiyn: costOf(usage, pricing),
    });
    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    let findings: AiReviewFinding[];
    try {
      const detailed = provider.generateDetailed ? await provider.generateDetailed(prompt) : { output: await provider.generate(prompt), usage: null };
      usage = detailed.usage;
      findings = normalizeAiReview(detailed.output, targets);
    } catch (error) {
      const code = error instanceof StageAiError ? error.code : 'AI_FAILED';
      await this.prisma.generationRun.create({ data: { ...runData(usage), status: 'failed', safeErrorCode: code } });
      if (code === 'AI_INVALID_RESPONSE') throw new BadGatewayException(code);
      throw new ServiceUnavailableException(code);
    }
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.generationRun.create({ data: { ...runData(usage), status: 'succeeded' }, select: { id: true } });
      await tx.stageAiReview.create({ data: { projectId, stageId: stage.id, versionId: version.id, generationRunId: run.id, findings: findings as never, requestedByUserId: userId } });
      await this.core.event(tx, projectId, userId, 'stage_ai_reviewed', key, { versionNumber: version.versionNumber, findings: findings.length });
      if (assignment) await tx.stageAssignment.update({ where: { id: assignment.id }, data: { aiUsed: { increment: 1 } } });
    });
    return { data: { findings } };
  }

  /** Used by acceptance and the last approval: every blocking finding is fixed or explained for this very version. */
  async assertPasses(ctx: Ctx, key: StageKey, stageId: string, version: { id: string; content: unknown }) {
    const review = await this.reviewOf(ctx, key, version.content);
    const open = uncoveredBlocking(review, await StageReviewService.overridden(this.prisma, stageId, version.id));
    if (open.length) throw new ConflictException(`REVIEW_BLOCKING_OPEN:${open.map((finding) => finding.id).join(',')}`);
  }

  /** The owner moves on despite blocking findings and says why; the explanation stays in the stage history. */
  async override(userId: string, projectId: string, key: string, input: { versionId: string; findingIds: string[]; reason: string }) {
    const ctx = await this.core.load(userId, projectId, 'accept', key);
    const stage = this.core.stageOf(ctx, key);
    if (stage.currentVersionId !== input.versionId) throw new ConflictException('STAGE_VERSION_CONFLICT');
    const reason = input.reason.trim();
    if (reason.length < 10) throw new BadRequestException('REASON_TOO_SHORT');
    if (reason.length > REVIEW_LIMITS.reason) throw new BadRequestException('REASON_TOO_LONG');
    const version = await this.core.versionContent(input.versionId);
    if (!version) throw new ConflictException('STAGE_VERSION_CONFLICT');
    const review = await this.reviewOf(ctx, key as StageKey, version.content);
    const blocking = new Set(review.findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.id));
    const ids = [...new Set(input.findingIds)];
    if (!ids.length || ids.some((id) => !blocking.has(id))) throw new BadRequestException('FINDING_NOT_BLOCKING');
    await this.prisma.$transaction(async (tx) => {
      await tx.stageReviewOverride.create({ data: { projectId, stageId: stage.id, versionId: version.id, rulesVersion: review.rulesVersion, findingIds: ids, reason, authorUserId: userId } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'review_override', stageKey: key, details: { versionId: version.id, findingIds: ids } } });
    });
    return { data: { overridden: ids } };
  }

  /** «Let the AI fix these»: the instruction is made from the chosen findings' own texts, and the new version is reviewed again. */
  async fix(userId: string, projectId: string, key: string, input: { findingIds: string[] }) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const stage = this.core.stageOf(ctx, key);
    const version = await this.core.versionContent(stage.currentVersionId);
    if (!version) throw new ConflictException('NOTHING_TO_FIX');
    const review = await this.reviewOf(ctx, key as StageKey, version.content);
    const advice = (await this.latestAi(stage.id, version.id))?.findings ?? [];
    const wanted = new Set(input.findingIds);
    const chosen: Array<Pick<ReviewFinding, 'where' | 'message' | 'fix'>> = [...review.findings, ...advice].filter((finding) => wanted.has(finding.id));
    if (!chosen.length) throw new BadRequestException('FINDINGS_NOT_FOUND');
    return this.stageAi.generate(userId, projectId, key, { instruction: fixInstruction(chosen), saveAs: 'one_off', targetKey: null });
  }
}
