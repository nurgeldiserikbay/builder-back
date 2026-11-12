import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';
import { DEFAULT_TOKENS, MAX_LIMIT_TENGE, estimateRoute, requestCost, spendLimitState, tenge } from './budget.js';

const MAX_PRICE_TENGE = 1_000_000;

@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService, private readonly worktime: WorktimeService) {}

  async pricing() {
    const row = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    return { data: row ? { inputPerMillion: tenge(row.inputPerMillionTiyn), outputPerMillion: tenge(row.outputPerMillionTiyn), updatedAt: row.updatedAt, typicalRequest: await this.typicalTokens() } : null };
  }

  /** Prices in tenge per million tokens. A change applies to new requests only; past requests keep their cost. */
  async updatePricing(staffId: string, input: number, output: number) {
    for (const value of [input, output]) if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE_TENGE) throw new BadRequestException('INVALID_PRICE');
    const previous = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    const next = { inputPerMillionTiyn: Math.round(input * 100), outputPerMillionTiyn: Math.round(output * 100) };
    await this.prisma.$transaction([
      this.prisma.aiPricing.upsert({ where: { id: 1 }, create: { id: 1, ...next, updatedByStaffId: staffId }, update: { ...next, updatedByStaffId: staffId } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'billing.ai_pricing_changed', targetType: 'ai_pricing', targetId: '1', details: {
        previousInput: previous ? tenge(previous.inputPerMillionTiyn) : null, previousOutput: previous ? tenge(previous.outputPerMillionTiyn) : null, nextInput: input, nextOutput: output,
      } } }),
    ]);
    return this.pricing();
  }

  private typicalCache: { at: number; value: { input: number; output: number; basedOn: number } } | null = null;

  /**
   * Average tokens of recent successful requests across the platform; defaults until there are enough of them.
   * Cached for 10 minutes: it reads every request of the platform in the last 30 days and changes slowly.
   */
  private async typicalTokens() {
    if (this.typicalCache && Date.now() - this.typicalCache.at < 10 * 60_000) return this.typicalCache.value;
    const value = await this.computeTypicalTokens();
    this.typicalCache = { at: Date.now(), value };
    return value;
  }

  private async computeTypicalTokens() {
    const recent = await this.prisma.generationRun.aggregate({
      where: { status: 'succeeded', inputTokens: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _avg: { inputTokens: true, outputTokens: true }, _count: { _all: true },
    });
    if (recent._count._all < 20) return { ...DEFAULT_TOKENS, basedOn: 0 };
    return { input: Math.round(recent._avg.inputTokens ?? DEFAULT_TOKENS.input), output: Math.round(recent._avg.outputTokens ?? DEFAULT_TOKENS.output), basedOn: recent._count._all };
  }

  /** Owner or manager sets or removes the project's cap on AI spending (tenge, whole number). Logged in the project history. */
  async setSpendLimit(userId: string, projectId: string, amount: number | null) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (!access.canDecide) throw new ForbiddenException('SPEND_LIMIT_FORBIDDEN');
    if (amount !== null && (!Number.isInteger(amount) || amount < 1 || amount > MAX_LIMIT_TENGE)) throw new BadRequestException('SPEND_LIMIT_INVALID');
    const next = amount === null ? null : amount * 100;
    const previous = await this.prisma.project.findUnique({ where: { id: projectId }, select: { aiSpendLimitTiyn: true } });
    if ((previous?.aiSpendLimitTiyn ?? null) !== next) {
      await this.prisma.$transaction([
        this.prisma.project.update({ where: { id: projectId }, data: { aiSpendLimitTiyn: next } }),
        this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ai_spend_limit_changed', details: { previous: previous?.aiSpendLimitTiyn == null ? null : tenge(previous.aiSpendLimitTiyn), next: amount } } }),
      ]);
    }
    return this.projectBudget(userId, projectId);
  }

  /** Estimate for the route and what was spent, by stage and by participant. Members of the project only. */
  async projectBudget(userId: string, projectId: string) {
    const access = await this.journey.projectAccess(userId, projectId);
    const [row, stages, runs, byAuthor, project] = await Promise.all([
      this.prisma.aiPricing.findUnique({ where: { id: 1 } }),
      this.prisma.projectStage.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { id: true, stageKey: true, status: true } }),
      this.prisma.generationRun.groupBy({ by: ['stageId'], where: { projectId, provider: { not: 'template' } }, _count: { _all: true }, _sum: { costTiyn: true } }),
      this.prisma.generationRun.groupBy({ by: ['requestedByUserId'], where: { projectId, provider: { not: 'template' } }, _count: { _all: true }, _sum: { costTiyn: true } }),
      this.prisma.project.findUnique({ where: { id: projectId }, select: { aiSpendLimitTiyn: true } }),
    ]);
    const unpriced = await this.prisma.generationRun.count({ where: { projectId, provider: { not: 'template' }, costTiyn: null } });
    const tokens = await this.typicalTokens();
    const route = stages.filter((stage) => stage.stageKey in stageDefinitions).map((stage) => ({
      id: stage.id, key: stage.stageKey as StageKey, done: ['approved', 'imported', 'skipped'].includes(stage.status), aiUsed: stageDefinitions[stage.stageKey as StageKey].ai.level !== 'none',
    }));
    const estimate = row ? estimateRoute(route, tokens, row) : null;
    const users = await this.prisma.user.findMany({ where: { id: { in: byAuthor.map((item) => item.requestedByUserId) } }, select: { id: true, name: true, email: true } });
    const spentTotal = runs.reduce((sum, item) => sum + (item._sum.costTiyn ?? 0), 0);
    const cap = spendLimitState(spentTotal, project?.aiSpendLimitTiyn ?? null, row ? requestCost(DEFAULT_TOKENS, row) : 0);
    return {
      data: {
        pricingConfigured: Boolean(row),
        perRequest: estimate ? tenge(estimate.perRequest) : null,
        estimate: estimate ? { min: tenge(estimate.total.min), max: tenge(estimate.total.max), remainingMin: tenge(estimate.remaining.min), remainingMax: tenge(estimate.remaining.max), basedOnRequests: tokens.basedOn } : null,
        spent: { total: tenge(spentTotal), requests: runs.reduce((sum, item) => sum + item._count._all, 0), unpricedRequests: unpriced },
        // Owner's cap: warn from 80%, block when a typical request no longer fits. Only counted once prices are set.
        limit: cap.limitTiyn === null ? null : { amount: tenge(cap.limitTiyn), left: tenge(cap.leftTiyn!), percent: Math.round(cap.share! * 100), warn: cap.warn, blocked: Boolean(row) && cap.blocked },
        canSetLimit: access.canDecide,
        stages: route.map((stage) => {
          const used = runs.find((item) => item.stageId === stage.id);
          const planned = estimate?.perStage.find((item) => item.key === stage.key);
          return {
            key: stage.key, title: stageDefinitions[stage.key].title, done: stage.done, aiUsed: stage.aiUsed,
            spent: tenge(used?._sum.costTiyn ?? 0), requests: used?._count._all ?? 0,
            planned: planned ? { requestsMin: planned.requests.min, requestsMax: planned.requests.max, min: tenge(planned.cost.min), max: tenge(planned.cost.max) } : null,
          };
        }),
        participants: byAuthor.map((item) => {
          const user = users.find((candidate) => candidate.id === item.requestedByUserId);
          return { id: item.requestedByUserId, name: item.requestedByUserId === userId ? 'Вы' : user?.name || user?.email || 'Удалённый участник', spent: tenge(item._sum.costTiyn ?? 0), requests: item._count._all };
        }),
        // Rates and amounts of other people are for those who decide on the project.
        specialists: access.canDecide ? await this.worktime.projectSummary(projectId) : null,
        currency: 'KZT',
      },
    };
  }
}
