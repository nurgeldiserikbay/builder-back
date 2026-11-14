import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { JourneyCore } from './journey-core.js';
import { StageAiService } from './stage-ai.service.js';
import { fixInstruction, REVIEW_LIMITS, reviewStage, uncoveredBlocking, type StageReview } from './stage-review.js';

type Ctx = Awaited<ReturnType<JourneyCore['load']>>;

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
    };
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
    const wanted = new Set(input.findingIds);
    const chosen = review.findings.filter((finding) => wanted.has(finding.id));
    if (!chosen.length) throw new BadRequestException('FINDINGS_NOT_FOUND');
    return this.stageAi.generate(userId, projectId, key, { instruction: fixInstruction(chosen), saveAs: 'one_off', targetKey: null });
  }
}
