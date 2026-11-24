import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';
import { minutesOf, plannedAmount, summarize, type Terms } from '../journey/worktime.js';
import { billingSettings } from '../payments/wallet.js';
import { moneyByStatus, weekMinutes } from './work-rules.js';

const tenge = (tiyn: number) => tiyn / 100;
const RECENT_DAYS = 180;

/**
 * «Моя работа» — a specialist's own workspace across projects: the stages they work on, their time, what they have
 * earned and what is still on the way, their reviews and what is missing to be paid.
 * Only the specialist's own assignments are read; nothing about the owner's wallet or other people's terms.
 */
@Injectable()
export class WorkService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(userId: string) {
    const now = new Date();
    const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
    const [rows, reviews, payout, profile, settings] = await Promise.all([
      this.prisma.stageAssignment.findMany({
        where: { userId, OR: [{ status: 'active' }, { status: 'completed', completedAt: { gte: since } }] },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        select: {
          id: true, role: true, status: true, aiBudget: true, aiUsed: true, acceptedAt: true, completedAt: true, readUntil: true,
          payKind: true, fixedAmountTiyn: true, hourlyRateTiyn: true, hourLimit: true, weeklyHourLimit: true, onlyResultTime: true,
          project: { select: { id: true, name: true, projectType: true, status: true } },
          stage: { select: { stageKey: true, status: true } },
          timeEntries: { select: { startedAt: true, endedAt: true, source: true, actions: true, status: true, createdAt: true } },
          payments: { orderBy: { createdAt: 'desc' }, select: { id: true, amountTiyn: true, payoutTiyn: true, status: true, createdAt: true, paidAt: true, paidOutAt: true } },
          disputes: { where: { status: 'open' }, select: { id: true } },
        },
      }),
      this.prisma.specialistReview.findMany({
        where: { specialistUserId: userId, reportStatus: { not: 'hidden' } },
        orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, rating: true, text: true, stageKey: true, projectType: true, createdAt: true, reply: true },
      }),
      this.prisma.payoutDetails.findUnique({ where: { userId }, select: { ibanHint: true } }),
      this.prisma.specialistProfile.findUnique({ where: { userId }, select: { published: true, blockedAt: true } }),
      billingSettings(this.prisma),
    ]);

    const allEntries = rows.flatMap((row) => row.timeEntries);
    const allPayments = rows.flatMap((row) => row.payments);
    const money = moneyByStatus(allPayments);

    return {
      data: {
        assignments: rows.map((row) => {
          const terms: Terms = row;
          const time = summarize(row.timeEntries, terms, now);
          const own = moneyByStatus(row.payments);
          return {
            id: row.id, role: row.role, status: row.status,
            projectId: row.project.id, projectName: row.project.name, projectType: row.project.projectType, projectStatus: row.project.status,
            stageKey: row.stage.stageKey, stageTitle: stageDefinitions[row.stage.stageKey as StageKey]?.title ?? row.stage.stageKey, stageStatus: row.stage.status,
            terms: {
              payKind: row.payKind, fixedAmount: row.fixedAmountTiyn === null ? null : tenge(row.fixedAmountTiyn),
              hourlyRate: row.hourlyRateTiyn === null ? null : tenge(row.hourlyRateTiyn), hourLimit: row.hourLimit, weeklyHourLimit: row.weeklyHourLimit,
            },
            time: {
              trackedMinutes: time.trackedMinutes, approvedMinutes: time.approvedMinutes, pendingMinutes: time.pendingMinutes, disputedMinutes: time.disputedMinutes,
              limitMinutes: time.limitMinutes, weekMinutes: weekMinutes(row.timeEntries, now),
            },
            planned: tenge(plannedAmount(terms)),
            /** What the approved time is worth under the terms now (for a fixed price — the price). */
            earnedSoFar: tenge(time.amountDueTiyn),
            money: { awaitingOwner: tenge(own.awaitingOwner), held: tenge(own.held), paidOut: tenge(own.paidOut) },
            ai: { budget: row.aiBudget, used: row.aiUsed },
            openDispute: row.disputes.length > 0,
            acceptedAt: row.acceptedAt, completedAt: row.completedAt, readUntil: row.readUntil,
          };
        }),
        totals: {
          awaitingOwner: tenge(money.awaitingOwner), held: tenge(money.held), paidOut: tenge(money.paidOut),
          paidOutLast30: tenge(moneyByStatus(allPayments.filter((payment) => (payment.paidOutAt ?? payment.paidAt ?? payment.createdAt) >= new Date(now.getTime() - 30 * 86_400_000))).paidOut),
          weekMinutes: weekMinutes(allEntries, now),
          pendingMinutes: rows.reduce((sum, row) => sum + summarize(row.timeEntries, row, now).pendingMinutes, 0),
        },
        // Raw intervals of the last week: the screen groups them by the person's own days.
        recentTime: allEntries.filter((entry) => entry.startedAt.getTime() >= now.getTime() - 7 * 86_400_000).map((entry) => ({ startedAt: entry.startedAt, minutes: minutesOf(entry) })),
        payments: rows
          .flatMap((row) => row.payments.map((payment) => ({
            id: payment.id, projectId: row.project.id, projectName: row.project.name, stageKey: row.stage.stageKey,
            stageTitle: stageDefinitions[row.stage.stageKey as StageKey]?.title ?? row.stage.stageKey,
            amount: tenge(payment.amountTiyn), payout: payment.payoutTiyn === null ? null : tenge(payment.payoutTiyn),
            status: payment.status, createdAt: payment.createdAt, paidOutAt: payment.paidOutAt ?? (payment.status === 'paid_direct' ? payment.paidAt : null),
          })))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 20),
        reviews: {
          count: reviews.length,
          average: reviews.length ? Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10 : null,
          latest: reviews.slice(0, 5).map((review) => ({
            id: review.id, rating: review.rating, text: review.text, stageKey: review.stageKey,
            stageTitle: stageDefinitions[review.stageKey as StageKey]?.title ?? review.stageKey, projectType: review.projectType,
            createdAt: review.createdAt, replied: Boolean(review.reply),
          })),
        },
        setup: {
          payoutDetails: Boolean(payout), payoutHint: payout?.ibanHint ?? null,
          profile: !profile ? 'none' : profile.blockedAt ? 'blocked' : profile.published ? 'published' : 'draft',
        },
        feePercent: settings.specialistFeeBp / 100,
        currency: 'KZT',
      },
    };
  }
}
