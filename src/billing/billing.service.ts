import { billingSettings, projectBalance, walletLockKey } from '../payments/wallet.js';
import { DEFAULT_TOKENS, costOf, spendLimitState } from '../budget/budget.js';
import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PLAN_CATALOG_VERSION, limitLabels, monthStart, paidPlanKeys, planOf, plans, priceOf, validContactUrl, type LimitKey, type PaidPlanKey, type PlanKey } from './plans.js';

/** A hold older than this belongs to a request that crashed; it stops counting. */
const AI_HOLD_MS = 10 * 60_000;

export class PlanLimitException extends ForbiddenException {
  constructor(code: string) { super(code); }
}

/** Plans, usage and limit checks. Limits are always counted for the project owner's account. */
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async planFor(userId: string) {
    const row = await this.prisma.accountPlan.findUnique({ where: { userId }, select: { planKey: true, validUntil: true } });
    return { ...planOf(row?.planKey, row?.validUntil), validUntil: row?.validUntil ?? null, assignedKey: row?.planKey ?? 'free' };
  }

  async usage(userId: string): Promise<Record<LimitKey, number>> {
    const [projects, aiPerMonth, liveSites] = await Promise.all([
      this.prisma.project.count({ where: { ownerUserId: userId, projectType: { not: null }, status: { not: 'archived' } } }),
      this.prisma.generationRun.count({ where: { project: { ownerUserId: userId }, provider: { not: 'template' }, status: 'succeeded', createdAt: { gte: monthStart() } } }),
      this.prisma.sitePublication.count({ where: { project: { ownerUserId: userId }, status: 'live' } }),
    ]);
    return { projects, aiPerMonth, liveSites };
  }

  private async ensure(ownerUserId: string, key: LimitKey, code: string) {
    const { plan } = await this.planFor(ownerUserId);
    const used = (await this.usage(ownerUserId))[key];
    if (used >= plan.limits[key]) throw new PlanLimitException(code);
  }

  assertCanCreateProject(ownerUserId: string) { return this.ensure(ownerUserId, 'projects', 'PLAN_LIMIT_PROJECTS'); }

  /**
   * Before an AI request: plan limit, then — under the project wallet lock — one request at a time and, with prepaid
   * billing, a hold of twice a typical request's price that must fit in the balance. The owner's spending cap is
   * checked under the same lock. Returns the hold to release once the request's actual cost is recorded.
   */
  async reserveAi(projectId: string, now = new Date()): Promise<string> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    await this.ensure(project.ownerUserId, 'aiPerMonth', 'PLAN_LIMIT_AI');
    const settings = await billingSettings(this.prisma);
    const prepaid = settings.mode === 'prepaid' && settings.priced;
    const typical = settings.priced ? costOf({ inputTokens: DEFAULT_TOKENS.input, outputTokens: DEFAULT_TOKENS.output }, { inputPerMillionTiyn: settings.inputPerMillionTiyn, outputPerMillionTiyn: settings.outputPerMillionTiyn }) ?? 0 : 0;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${walletLockKey(projectId)}))`;
      await tx.aiReservation.deleteMany({ where: { projectId, expiresAt: { lte: now } } });
      if (await tx.aiReservation.count({ where: { projectId } })) throw new ConflictException('AI_ALREADY_RUNNING');
      // Without prices there is nothing to count against the cap.
      if (settings.priced) {
        const row = await tx.project.findUnique({ where: { id: projectId }, select: { aiSpendLimitTiyn: true } });
        if (row?.aiSpendLimitTiyn != null) {
          const spent = await tx.generationRun.aggregate({ where: { projectId, costTiyn: { not: null } }, _sum: { costTiyn: true } });
          const cap = spendLimitState(spent._sum.costTiyn ?? 0, row.aiSpendLimitTiyn, typical);
          if (cap.blocked) throw new HttpException({ statusCode: 402, message: 'PROJECT_SPEND_LIMIT', limit: row.aiSpendLimitTiyn / 100, spent: (spent._sum.costTiyn ?? 0) / 100 }, HttpStatus.PAYMENT_REQUIRED);
        }
      }
      let amountTiyn = 0;
      if (prepaid) {
        const { balanceTiyn } = await projectBalance(tx, projectId, settings.prepaidSince, now);
        if (balanceTiyn < typical) throw new HttpException({ statusCode: 402, message: 'PROJECT_BALANCE_LOW', balance: balanceTiyn / 100 }, HttpStatus.PAYMENT_REQUIRED);
        // Answers vary in length: hold up to twice a typical request, never more than is there.
        amountTiyn = Math.min(2 * typical, balanceTiyn);
      }
      const hold = await tx.aiReservation.create({ data: { projectId, amountTiyn, expiresAt: new Date(now.getTime() + AI_HOLD_MS) }, select: { id: true } });
      return hold.id;
    });
  }

  async releaseAi(reservationId: string): Promise<void> {
    await this.prisma.aiReservation.deleteMany({ where: { id: reservationId } });
  }

  /** Republishing a site that is already live does not take a new slot. */
  async assertCanPublish(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true, publication: { select: { status: true } } } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (project.publication?.status === 'live') return;
    return this.ensure(project.ownerUserId, 'liveSites', 'PLAN_LIMIT_SITES');
  }

  async assertCanInviteSpecialists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const { plan } = await this.planFor(project.ownerUserId);
    if (!plan.specialists) throw new PlanLimitException('PLAN_NO_SPECIALISTS');
  }

  /** A new owner's plan must hold the project: a project slot, a live-site slot if it is published, a team if it has one. */
  async assertCanReceiveProject(userId: string, project: { counts: boolean; live: boolean; team: boolean }) {
    if (project.counts) await this.ensure(userId, 'projects', 'PLAN_LIMIT_PROJECTS');
    if (project.live) await this.ensure(userId, 'liveSites', 'PLAN_LIMIT_SITES');
    if (project.team && !(await this.planFor(userId)).plan.specialists) throw new PlanLimitException('PLAN_NO_TEAM');
  }

  /** A team (members beyond the owner) is part of the same paid plans as specialists. */
  async assertCanInviteTeam(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const { plan } = await this.planFor(project.ownerUserId);
    if (!plan.specialists) throw new PlanLimitException('PLAN_NO_TEAM');
  }

  /** AI requests left this month on the project owner's plan. */
  async remainingAi(projectId: string): Promise<{ left: number; limit: number; planTitle: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) return { left: 0, limit: 0, planTitle: '' };
    const [{ plan }, usage] = await Promise.all([this.planFor(project.ownerUserId), this.usage(project.ownerUserId)]);
    return { left: Math.max(0, plan.limits.aiPerMonth - usage.aiPerMonth), limit: plan.limits.aiPerMonth, planTitle: plan.title };
  }

  private async prices(): Promise<Record<PaidPlanKey, number | null>> {
    const rows = await this.prisma.planPrice.findMany({ select: { planKey: true, monthlyPriceKzt: true } });
    const result: Record<PaidPlanKey, number | null> = { start: null, business: null };
    for (const row of rows) if ((paidPlanKeys as string[]).includes(row.planKey)) result[row.planKey as PaidPlanKey] = row.monthlyPriceKzt;
    return result;
  }

  /** Contact set in the admin console; SALES_CONTACT_URL is only a fallback for a fresh install. */
  private async contactUrl(): Promise<string | null> {
    const row = await this.prisma.billingSettings.findUnique({ where: { id: 1 }, select: { salesContactUrl: true } });
    return validContactUrl(row?.salesContactUrl) ?? validContactUrl(process.env.SALES_CONTACT_URL);
  }

  async catalog() {
    const prices = await this.prices();
    return Object.values(plans).map((plan) => {
      const monthlyPriceKzt = plan.paid ? prices[plan.key as PaidPlanKey] : 0;
      return { key: plan.key, title: plan.title, description: plan.description, limits: plan.limits, specialists: plan.specialists, monthlyPriceKzt, price: priceOf(plan, monthlyPriceKzt) };
    });
  }

  async settings() {
    const [prices, settings] = await Promise.all([
      this.prisma.planPrice.findMany({ select: { planKey: true, updatedAt: true } }),
      this.prisma.billingSettings.findUnique({ where: { id: 1 }, select: { salesContactUrl: true, updatedAt: true } }),
    ]);
    return {
      data: {
        catalogVersion: PLAN_CATALOG_VERSION,
        plans: await this.catalog(),
        priceUpdatedAt: Object.fromEntries(prices.map((row) => [row.planKey, row.updatedAt])),
        salesContactUrl: settings?.salesContactUrl ?? null,
        salesContactFallback: settings?.salesContactUrl ? null : validContactUrl(process.env.SALES_CONTACT_URL),
        updatedAt: settings?.updatedAt ?? null,
      },
    };
  }

  /** Staff change of prices and the upgrade contact. Assigned plans are not touched; prices are informational until online payment exists. */
  async updateSettings(staffId: string, input: { prices: Partial<Record<PaidPlanKey, number | null>>; salesContactUrl?: string | null }) {
    const before = await this.prices();
    const current = await this.prisma.billingSettings.findUnique({ where: { id: 1 }, select: { salesContactUrl: true } });
    await this.prisma.$transaction(async (tx) => {
      for (const key of paidPlanKeys) {
        if (!(key in input.prices) || (input.prices[key] ?? null) === before[key]) continue;
        const next = input.prices[key] ?? null;
        await tx.planPrice.upsert({ where: { planKey: key }, create: { planKey: key, monthlyPriceKzt: next, updatedByStaffId: staffId }, update: { monthlyPriceKzt: next, updatedByStaffId: staffId } });
        await tx.adminAuditEvent.create({ data: { staffId, eventType: 'plan.price_changed', targetType: 'plan', targetId: key, details: { planKey: key, previousPrice: before[key], nextPrice: next } } });
      }
      if (input.salesContactUrl !== undefined && (input.salesContactUrl ?? null) !== (current?.salesContactUrl ?? null)) {
        await tx.billingSettings.upsert({ where: { id: 1 }, create: { id: 1, salesContactUrl: input.salesContactUrl, updatedByStaffId: staffId }, update: { salesContactUrl: input.salesContactUrl, updatedByStaffId: staffId } });
        await tx.adminAuditEvent.create({ data: { staffId, eventType: 'billing.contact_changed', targetType: 'billing_settings', targetId: '1', details: { contactSet: Boolean(input.salesContactUrl) } } });
      }
    });
    return this.settings();
  }

  async overview(userId: string) {
    const [{ plan, expired, validUntil, assignedKey }, usage] = await Promise.all([this.planFor(userId), this.usage(userId)]);
    const [catalog, contact] = await Promise.all([this.catalog(), this.contactUrl()]);
    return {
      data: {
        catalogVersion: PLAN_CATALOG_VERSION,
        plan: { key: plan.key, title: plan.title, specialists: plan.specialists, validUntil: expired ? null : validUntil, expired, expiredPlanTitle: expired ? plans[assignedKey as PlanKey]?.title ?? null : null },
        usage: (Object.keys(limitLabels) as LimitKey[]).map((key) => ({ key, ...limitLabels[key], used: usage[key], limit: plan.limits[key] })),
        periodStart: monthStart(),
        plans: catalog,
        upgrade: { contactUrl: contact },
      },
    };
  }

  /** Staff assignment after payment is confirmed outside the platform. */
  async assign(staffId: string, input: { email: string; planKey: PlanKey; validUntil: Date | null; note: string | null }) {
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: input.email.trim().toLowerCase() }, select: { id: true, email: true } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      if (input.planKey === 'free') await tx.accountPlan.deleteMany({ where: { userId: user.id } });
      else await tx.accountPlan.upsert({
        where: { userId: user.id },
        create: { userId: user.id, planKey: input.planKey, validUntil: input.validUntil, note: input.note, assignedByStaffId: staffId },
        update: { planKey: input.planKey, validUntil: input.validUntil, note: input.note, assignedByStaffId: staffId },
      });
      await tx.adminAuditEvent.create({ data: { staffId, eventType: 'account.plan_assigned', targetType: 'user', targetId: user.id, details: { planKey: input.planKey, validUntil: input.validUntil?.toISOString() ?? null, note: input.note } } });
    });
    return this.staffView(user.id, user.email);
  }

  async staffLookup(email: string) {
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() }, select: { id: true, email: true } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    return this.staffView(user.id, user.email);
  }

  private async staffView(userId: string, email: string) {
    const overview = (await this.overview(userId)).data;
    const row = await this.prisma.accountPlan.findUnique({ where: { userId }, select: { note: true, updatedAt: true } });
    return { data: { userId, email, plan: overview.plan, usage: overview.usage, note: row?.note ?? null, updatedAt: row?.updatedAt ?? null } };
  }
}
