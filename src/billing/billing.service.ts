import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PLAN_CATALOG_VERSION, limitLabels, monthStart, planOf, plans, priceOf, type LimitKey, type PlanKey } from './plans.js';

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

  async assertCanGenerate(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    return this.ensure(project.ownerUserId, 'aiPerMonth', 'PLAN_LIMIT_AI');
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

  /** AI requests left this month on the project owner's plan. */
  async remainingAi(projectId: string): Promise<{ left: number; limit: number; planTitle: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } });
    if (!project) return { left: 0, limit: 0, planTitle: '' };
    const [{ plan }, usage] = await Promise.all([this.planFor(project.ownerUserId), this.usage(project.ownerUserId)]);
    return { left: Math.max(0, plan.limits.aiPerMonth - usage.aiPerMonth), limit: plan.limits.aiPerMonth, planTitle: plan.title };
  }

  catalog() {
    return Object.values(plans).map((plan) => ({
      key: plan.key, title: plan.title, description: plan.description, limits: plan.limits, specialists: plan.specialists, price: priceOf(plan),
    }));
  }

  async overview(userId: string) {
    const [{ plan, expired, validUntil, assignedKey }, usage] = await Promise.all([this.planFor(userId), this.usage(userId)]);
    const contact = process.env.SALES_CONTACT_URL?.trim() || null;
    return {
      data: {
        catalogVersion: PLAN_CATALOG_VERSION,
        plan: { key: plan.key, title: plan.title, specialists: plan.specialists, validUntil: expired ? null : validUntil, expired, expiredPlanTitle: expired ? plans[assignedKey as PlanKey]?.title ?? null : null },
        usage: (Object.keys(limitLabels) as LimitKey[]).map((key) => ({ key, ...limitLabels[key], used: usage[key], limit: plan.limits[key] })),
        periodStart: monthStart(),
        plans: this.catalog(),
        upgrade: { contactUrl: contact && /^(https:\/\/|mailto:|tg:\/\/)/.test(contact) ? contact : null },
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
