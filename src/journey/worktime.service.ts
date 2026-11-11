import { inLocale, money, tr, type Message } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { activeProvider } from '../payments/providers.js';
import { billingSettings } from '../payments/wallet.js';
import { IDLE_MS, WARN_SHARE, effectiveStatus, minutesOf, plannedAmount, summarize, withoutResult, type Terms } from './worktime.js';

const managers = new Set(['owner', 'manager']);
const termsSelect = { payKind: true, fixedAmountTiyn: true, hourlyRateTiyn: true, hourLimit: true, onlyResultTime: true } as const;
const tenge = (tiyn: number) => tiyn / 100;

/** Time tracking, timesheets and payments due for specialists on stages. */
@Injectable()
export class WorktimeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records activity of an active assignment: extends the current interval if the specialist was active in the last 5 minutes,
   * otherwise starts a new one. Stops at the hour limit. Called for heartbeats from the stage page and for actions on the stage.
   */
  async touch(assignmentId: string, action: boolean, now = new Date()): Promise<{ tracking: boolean; limitReached: boolean }> {
    const assignment = await this.prisma.stageAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, status: true, projectId: true, userId: true, limitWarnedAt: true, weeklyHourLimit: true, ...termsSelect, stage: { select: { stageKey: true } }, project: { select: { name: true, ownerUserId: true } } },
    });
    if (!assignment || assignment.status !== 'active') return { tracking: false, limitReached: false };
    const entries = await this.prisma.timeEntry.findMany({ where: { assignmentId }, select: { startedAt: true, endedAt: true } });
    const used = entries.reduce((sum, entry) => sum + minutesOf(entry), 0);
    const limit = assignment.hourLimit ? assignment.hourLimit * 60 : null;
    if (limit !== null && used >= limit) return { tracking: false, limitReached: true };
    if (assignment.weeklyHourLimit) {
      const weekStart = new Date(now); weekStart.setUTCHours(0, 0, 0, 0); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
      const week = entries.filter((entry) => entry.startedAt >= weekStart).reduce((sum, entry) => sum + minutesOf(entry), 0);
      if (week >= assignment.weeklyHourLimit * 60) return { tracking: false, limitReached: true };
    }
    const last = await this.prisma.timeEntry.findFirst({ where: { assignmentId, source: 'tracked' }, orderBy: { endedAt: 'desc' }, select: { id: true, endedAt: true } });
    if (last && now.getTime() - last.endedAt.getTime() <= IDLE_MS) {
      await this.prisma.timeEntry.update({ where: { id: last.id }, data: { endedAt: now, ...(action ? { actions: { increment: 1 } } : {}) } });
    } else {
      await this.prisma.timeEntry.create({ data: { assignmentId, projectId: assignment.projectId, startedAt: new Date(now.getTime() - (action ? 0 : 60_000)), endedAt: now, source: 'tracked', actions: action ? 1 : 0 } });
    }
    if (limit !== null && !assignment.limitWarnedAt && used + 1 >= limit * WARN_SHARE) {
      await this.prisma.stageAssignment.update({ where: { id: assignmentId }, data: { limitWarnedAt: now } });
      const title = stageDefinitions[assignment.stage.stageKey as StageKey]?.title ?? assignment.stage.stageKey;
      const text = () => tr("На этапе «{0}» в проекте «{1}» использовано 80% лимита часов ({2} ч). Когда лимит закончится, учёт времени остановится, пока владелец его не увеличит.", [tr(title), assignment.project.name, assignment.hourLimit]);
      for (const userId of new Set([assignment.project.ownerUserId, assignment.userId].filter((id): id is string => Boolean(id)))) await this.notify(userId, text);
    }
    return { tracking: true, limitReached: false };
  }

  private async notify(userId: string | null, text: Message) {
    const config = telegramConfig();
    if (!config || !userId) return;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { chatId: true, user: { select: { locale: true } } } });
    if (identity) await sendTelegramMessage(config, identity.chatId, inLocale(identity.user.locale, text)).catch(() => undefined);
  }


  private async activeAssignment(userId: string, projectId: string, stageKey: string) {
    return this.prisma.stageAssignment.findFirst({ where: { projectId, userId, status: 'active', stage: { stageKey } }, select: { id: true } });
  }

  /** Heartbeat from an open stage page with recent input. A no-op for anyone without an active assignment on the stage. */
  async heartbeat(userId: string, projectId: string, stageKey: string) {
    const assignment = await this.activeAssignment(userId, projectId, stageKey);
    if (!assignment) return { data: { tracking: false, limitReached: false } };
    return { data: await this.touch(assignment.id, false) };
  }

  /** For actions made through the API (drafts, AI requests, submissions, suggestions). */
  async recordAction(userId: string, projectId: string, stageKey: string) {
    const assignment = await this.activeAssignment(userId, projectId, stageKey);
    if (assignment) await this.touch(assignment.id, true);
  }

  private async viewer(userId: string, projectId: string) {
    const member = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true } });
    return { manager: Boolean(member && managers.has(member.role)), member: Boolean(member) };
  }

  /** Timesheets of a stage: the owner sees every specialist, a specialist only themself. */
  async timesheet(userId: string, projectId: string, stageKey: string) {
    const viewer = await this.viewer(userId, projectId);
    const rows = await this.prisma.stageAssignment.findMany({
      where: { projectId, stage: { stageKey }, status: { in: ['active', 'completed'] }, ...(viewer.manager ? {} : { userId }) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, role: true, status: true, email: true, userId: true, weeklyHourLimit: true, revisionsIncluded: true, ...termsSelect,
        user: { select: { name: true } },
        timeEntries: { orderBy: { startedAt: 'desc' }, take: 200 },
        payments: { orderBy: { createdAt: 'desc' }, select: { id: true, basis: true, minutes: true, amountTiyn: true, feeTiyn: true, payoutTiyn: true, status: true, paidAt: true, paidOutAt: true, stageVersion: true, createdAt: true } },
      },
    });
    if (!viewer.manager && rows.length === 0 && !viewer.member) throw new NotFoundException('STAGE_NOT_FOUND');
    const now = new Date();
    const settings = await billingSettings(this.prisma);
    return {
      data: {
        canDecide: viewer.manager,
        payOnline: activeProvider() !== null, specialistFeePercent: settings.specialistFeeBp / 100,
        assignments: rows.map((row) => {
          const terms: Terms = row;
          const summary = summarize(row.timeEntries, terms, now);
          return {
            id: row.id, role: row.role, status: row.status, name: row.userId === userId ? 'Вы' : row.user?.name || row.email, isYou: row.userId === userId,
            terms: {
              payKind: row.payKind, fixedAmount: row.fixedAmountTiyn === null ? null : tenge(row.fixedAmountTiyn), hourlyRate: row.hourlyRateTiyn === null ? null : tenge(row.hourlyRateTiyn),
              hourLimit: row.hourLimit, weeklyHourLimit: row.weeklyHourLimit, revisionsIncluded: row.revisionsIncluded, onlyResultTime: row.onlyResultTime,
            },
            summary: { ...summary, amountDue: tenge(summary.amountDueTiyn) },
            entries: row.timeEntries.map((entry) => ({
              id: entry.id, startedAt: entry.startedAt, endedAt: entry.endedAt, minutes: minutesOf(entry), source: entry.source, actions: entry.actions,
              withoutResult: withoutResult(entry), note: entry.note, status: effectiveStatus(entry, now), ownerComment: entry.ownerComment, specialistReply: entry.specialistReply,
            })),
            payments: row.payments.map((payment) => ({ ...payment, amount: tenge(payment.amountTiyn), fee: payment.feeTiyn === null ? null : tenge(payment.feeTiyn), payout: payment.payoutTiyn === null ? null : tenge(payment.payoutTiyn) })),
          };
        }),
      },
    };
  }

  async addManual(userId: string, projectId: string, stageKey: string, input: { date: Date; minutes: number; note: string }) {
    const assignment = await this.activeAssignment(userId, projectId, stageKey);
    if (!assignment) throw new ForbiddenException('TIME_ENTRY_FORBIDDEN');
    if (input.date.getTime() > Date.now() || Date.now() - input.date.getTime() > 14 * 86_400_000) throw new BadRequestException('TIME_ENTRY_DATE_INVALID');
    await this.prisma.timeEntry.create({ data: { assignmentId: assignment.id, projectId, startedAt: input.date, endedAt: new Date(input.date.getTime() + input.minutes * 60_000), source: 'manual', note: input.note } });
    return this.timesheet(userId, projectId, stageKey);
  }

  private async entryFor(projectId: string, entryId: string) {
    const entry = await this.prisma.timeEntry.findFirst({ where: { id: entryId, projectId }, select: { id: true, status: true, createdAt: true, assignment: { select: { userId: true, status: true, stage: { select: { stageKey: true } } } } } });
    if (!entry) throw new NotFoundException('TIME_ENTRY_NOT_FOUND');
    return entry;
  }

  /** Owner approves or disputes an entry; a payment already created for the stage is not changed. */
  async decideEntry(userId: string, projectId: string, entryId: string, status: 'approved' | 'disputed', comment: string | null) {
    if (!(await this.viewer(userId, projectId)).manager) throw new ForbiddenException('TIME_DECISION_FORBIDDEN');
    const entry = await this.entryFor(projectId, entryId);
    if (status === 'disputed' && !comment) throw new BadRequestException('COMMENT_REQUIRED');
    await this.prisma.$transaction([
      this.prisma.timeEntry.update({ where: { id: entry.id }, data: { status, ownerComment: comment, decidedAt: new Date() } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: status === 'approved' ? 'time_approved' : 'time_disputed', stageKey: entry.assignment.stage.stageKey, details: { entryId } } }),
    ]);
    if (status === 'disputed' && entry.assignment.userId) await this.notify(entry.assignment.userId, () => tr("Владелец оспорил запись времени на этапе «{0}»: {1}", [tr(stageDefinitions[entry.assignment.stage.stageKey as StageKey]?.title ?? ''), comment]));
    return this.timesheet(userId, projectId, entry.assignment.stage.stageKey);
  }

  async replyToDispute(userId: string, projectId: string, entryId: string, reply: string) {
    const entry = await this.entryFor(projectId, entryId);
    if (entry.assignment.userId !== userId) throw new ForbiddenException('TIME_ENTRY_FORBIDDEN');
    if (entry.status !== 'disputed') throw new ConflictException('TIME_ENTRY_NOT_DISPUTED');
    await this.prisma.timeEntry.update({ where: { id: entry.id }, data: { specialistReply: reply } });
    return this.timesheet(userId, projectId, entry.assignment.stage.stageKey);
  }

  /**
   * On acceptance of a stage: what each paid specialist on it is owed. Fixed price — the amount from the terms;
   * hourly — approved (and, if set, productive) minutes within the limit × rate.
   */
  async paymentsOnAccept(tx: Pick<PrismaService, 'stageAssignment' | 'stagePayment'>, stageId: string, versionNumber: number) {
    const assignments = await tx.stageAssignment.findMany({ where: { stageId, status: 'active', payKind: { not: 'none' } }, select: { id: true, projectId: true, ...termsSelect, timeEntries: true } });
    const now = new Date();
    for (const assignment of assignments) {
      const summary = summarize(assignment.timeEntries, assignment, now);
      if (summary.amountDueTiyn <= 0) continue;
      await tx.stagePayment.create({ data: { assignmentId: assignment.id, projectId: assignment.projectId, basis: assignment.payKind, minutes: assignment.payKind === 'hourly' ? summary.payableMinutes : null, amountTiyn: summary.amountDueTiyn, stageVersion: versionNumber } });
    }
  }

  /** Until payments go through the platform, the owner marks what was paid directly. */
  async markPaid(userId: string, projectId: string, paymentId: string) {
    if (!(await this.viewer(userId, projectId)).manager) throw new ForbiddenException('PAYMENT_FORBIDDEN');
    const payment = await this.prisma.stagePayment.findFirst({ where: { id: paymentId, projectId }, select: { id: true, status: true, amountTiyn: true, assignment: { select: { userId: true, stage: { select: { stageKey: true } } } } } });
    if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
    if (payment.status !== 'due' && payment.status !== 'checkout') throw new ConflictException('PAYMENT_NOT_DUE');
    await this.prisma.$transaction([
      this.prisma.stagePayment.update({ where: { id: payment.id }, data: { status: 'paid_direct', paidAt: new Date(), markedByUserId: userId } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'specialist_paid_direct', stageKey: payment.assignment.stage.stageKey, details: { paymentId, amount: tenge(payment.amountTiyn) } } }),
    ]);
    if (payment.assignment.userId) await this.notify(payment.assignment.userId, () => tr("Владелец отметил оплату {0} ₸ за этап «{1}».", [money(payment.amountTiyn), tr(stageDefinitions[payment.assignment.stage.stageKey as StageKey]?.title ?? '')]));
    return this.timesheet(userId, projectId, payment.assignment.stage.stageKey);
  }

  /** Planned, due and paid amounts for the project estimate. */
  async projectSummary(projectId: string) {
    const rows = await this.prisma.stageAssignment.findMany({ where: { projectId, payKind: { not: 'none' }, status: { in: ['invited', 'active', 'completed'] } }, select: { ...termsSelect, payments: { select: { amountTiyn: true, status: true } } } });
    let planned = 0, due = 0, paid = 0;
    for (const row of rows) {
      planned += plannedAmount(row);
      for (const payment of row.payments) { if (payment.status === 'due' || payment.status === 'checkout') due += payment.amountTiyn; if (['paid_direct', 'paid', 'held', 'paid_out'].includes(payment.status)) paid += payment.amountTiyn; }
    }
    return { specialists: rows.length, planned: tenge(planned), due: tenge(due), paid: tenge(paid) };
  }
}
