import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { inLocale, tr, type Message } from '../i18n/i18n.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';
import { canOpen, checkClaim, checkMessage, checkResolution, kindsBySide, sideOf, type Side } from './dispute-rules.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const tenge = (tiyn: number | null) => (tiyn === null ? null : tiyn / 100);
const stageTitle = (key: string) => stageDefinitions[key as StageKey]?.title ?? key;

const assignmentSelect = {
  id: true, projectId: true, userId: true, status: true, acceptedAt: true, revokedAt: true, completedAt: true, email: true, role: true,
  payKind: true, fixedAmountTiyn: true, hourlyRateTiyn: true, hourLimit: true,
  stage: { select: { stageKey: true } },
  project: { select: { name: true, ownerUserId: true } },
  user: { select: { name: true } },
} as const;

const disputeSelect = {
  id: true, assignmentId: true, projectId: true, openedBySide: true, kind: true, claim: true, claimAmountTiyn: true, status: true, outcome: true,
  resolutionNote: true, resolvedAt: true, resultPaymentId: true, createdAt: true,
  messages: { orderBy: { createdAt: 'asc' as const }, select: { id: true, side: true, text: true, createdAt: true } },
} as const;

type DisputeRow = { id: string; assignmentId: string; projectId: string; openedBySide: string; kind: string; claim: string; claimAmountTiyn: number | null; status: string; outcome: string | null; resolutionNote: string | null; resolvedAt: Date | null; resultPaymentId: string | null; createdAt: Date; messages: Array<{ id: string; side: string; text: string; createdAt: Date }> };

/**
 * Disputes between a project owner and a specialist. Both sides see the same thread; neither sees the other's account
 * details. Staff decide from the stage history. While a dispute is open, BuildPath does not transfer money for that
 * assignment (checked in PaymentsService before a payout).
 */
@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  private async notify(userId: string | null, text: Message) {
    const config = telegramConfig();
    if (!config || !userId) return;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { userId_provider: { userId, provider: 'telegram' } }, select: { chatId: true, user: { select: { locale: true } } } });
    if (identity) await sendTelegramMessage(config, identity.chatId, inLocale(identity.user.locale, text)).catch(() => undefined);
  }

  /** The other side: the specialist, or the project owner. */
  private otherSide(side: Side, assignment: { userId: string | null; project: { ownerUserId: string } }) {
    return side === 'owner' ? assignment.userId : assignment.project.ownerUserId;
  }

  private async access(userId: string, assignmentId: string) {
    if (!isUuid(assignmentId)) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const assignment = await this.prisma.stageAssignment.findUnique({ where: { id: assignmentId }, select: assignmentSelect });
    if (!assignment) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { projectId: assignment.projectId, userId, status: 'active' }, select: { role: true } });
    const side = sideOf(userId, assignment, member?.role ?? null);
    // Someone with no say does not learn the assignment exists.
    if (!side) throw new NotFoundException('ASSIGNMENT_NOT_FOUND');
    return { assignment, side };
  }

  private view(row: DisputeRow, side: Side | 'staff') {
    return {
      id: row.id, kind: row.kind, openedBySide: row.openedBySide, mine: row.openedBySide === side, claim: row.claim, claimAmount: tenge(row.claimAmountTiyn),
      status: row.status, outcome: row.outcome, resolutionNote: row.resolutionNote, resolvedAt: row.resolvedAt, createdAt: row.createdAt, paymentCreated: Boolean(row.resultPaymentId),
      messages: row.messages.map((message) => ({ id: message.id, side: message.side, mine: message.side === side, text: message.text, createdAt: message.createdAt })),
      canWrite: row.status === 'open', canWithdraw: row.status === 'open' && row.openedBySide === side,
    };
  }

  /** Disputes of one assignment, for either side, plus what this side may open. */
  async forAssignment(userId: string, assignmentId: string) {
    const { assignment, side } = await this.access(userId, assignmentId);
    const rows = await this.prisma.dispute.findMany({ where: { assignmentId }, orderBy: { createdAt: 'desc' }, take: 20, select: disputeSelect });
    const open = canOpen(assignment, rows.some((row) => row.status === 'open'));
    return { data: { side, disputes: rows.map((row) => this.view(row, side)), canOpen: open.ok, kinds: kindsBySide[side], stageTitle: stageTitle(assignment.stage.stageKey) } };
  }

  async open(userId: string, assignmentId: string, input: { kind: unknown; claim: unknown; amount: unknown }) {
    const { assignment, side } = await this.access(userId, assignmentId);
    const checked = checkClaim(side, input);
    if (!checked.ok) throw new BadRequestException(checked.code);
    await this.prisma.$transaction(async (tx) => {
      const hasOpen = (await tx.dispute.count({ where: { assignmentId, status: 'open' } })) > 0;
      const allowed = canOpen(assignment, hasOpen);
      if (!allowed.ok) throw new ConflictException(allowed.code);
      // The partial unique index also refuses a second open dispute if two requests race.
      const created = await tx.dispute.create({ data: { assignmentId, projectId: assignment.projectId, openedByUserId: userId, openedBySide: side, kind: checked.kind, claim: checked.claim, claimAmountTiyn: checked.amountTiyn }, select: { id: true } });
      await tx.projectEvent.create({ data: { projectId: assignment.projectId, actorUserId: userId, type: 'dispute_opened', stageKey: assignment.stage.stageKey, details: { disputeId: created.id, assignmentId, side, kind: checked.kind, amount: tenge(checked.amountTiyn) } } });
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('DISPUTE_ALREADY_OPEN');
      throw error;
    });
    const title = stageTitle(assignment.stage.stageKey);
    await this.notify(this.otherSide(side, assignment), () => tr('По этапу «{0}» в проекте «{1}» открыт спор. Поддержка BuildPath разберёт его по истории этапа; вы можете добавить своё объяснение на странице этапа.', [tr(title), assignment.project.name]));
    return this.forAssignment(userId, assignmentId);
  }

  private async disputeFor(userId: string, disputeId: string) {
    if (!isUuid(disputeId)) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { id: true, assignmentId: true, status: true, openedBySide: true, _count: { select: { messages: true } } } });
    if (!dispute) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const { assignment, side } = await this.access(userId, dispute.assignmentId).catch(() => { throw new NotFoundException('DISPUTE_NOT_FOUND'); });
    return { dispute, assignment, side };
  }

  async message(userId: string, disputeId: string, text: unknown) {
    const { dispute, assignment, side } = await this.disputeFor(userId, disputeId);
    if (dispute.status !== 'open') throw new ConflictException('DISPUTE_CLOSED');
    const checked = checkMessage(text, dispute._count.messages);
    if (!checked.ok) throw new BadRequestException(checked.code);
    await this.prisma.disputeMessage.create({ data: { disputeId, side, authorUserId: userId, text: checked.text } });
    await this.notify(this.otherSide(side, assignment), () => tr('Новое сообщение в споре по этапу «{0}» проекта «{1}».', [tr(stageTitle(assignment.stage.stageKey)), assignment.project.name]));
    return this.forAssignment(userId, dispute.assignmentId);
  }

  async withdraw(userId: string, disputeId: string) {
    const { dispute, assignment, side } = await this.disputeFor(userId, disputeId);
    if (dispute.openedBySide !== side) throw new ForbiddenException('DISPUTE_WITHDRAW_FORBIDDEN');
    const updated = await this.prisma.dispute.updateMany({ where: { id: disputeId, status: 'open' }, data: { status: 'withdrawn', resolvedAt: new Date() } });
    if (!updated.count) throw new ConflictException('DISPUTE_CLOSED');
    await this.prisma.projectEvent.create({ data: { projectId: assignment.projectId, actorUserId: userId, type: 'dispute_withdrawn', stageKey: assignment.stage.stageKey, details: { disputeId } } });
    await this.notify(this.otherSide(side, assignment), () => tr('Спор по этапу «{0}» проекта «{1}» отозван.', [tr(stageTitle(assignment.stage.stageKey)), assignment.project.name]));
    return this.forAssignment(userId, dispute.assignmentId);
  }

  /** Disputes the user takes part in, newest first: for a list in the account. */
  async mine(userId: string) {
    const rows = await this.prisma.dispute.findMany({
      where: { OR: [{ assignment: { userId } }, { assignment: { project: { members: { some: { userId, status: 'active', role: { in: ['owner', 'manager'] } } } } } }] },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 50,
      select: { id: true, status: true, kind: true, outcome: true, createdAt: true, assignment: { select: { userId: true, projectId: true, project: { select: { name: true } }, stage: { select: { stageKey: true } } } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, status: row.status, kind: row.kind, outcome: row.outcome, createdAt: row.createdAt, projectId: row.assignment.projectId, projectName: row.assignment.project.name,
        stageKey: row.assignment.stage.stageKey, stageTitle: stageTitle(row.assignment.stage.stageKey), side: row.assignment.userId === userId ? 'specialist' : 'owner',
      })),
    };
  }

  // --- Staff ---

  async staffQueue(status: string) {
    const filter = status === 'closed' ? { status: { in: ['resolved', 'withdrawn'] } } : { status: 'open' };
    const rows = await this.prisma.dispute.findMany({
      where: filter, orderBy: { createdAt: status === 'closed' ? 'desc' : 'asc' }, take: 100,
      select: { id: true, status: true, kind: true, outcome: true, openedBySide: true, claimAmountTiyn: true, createdAt: true, _count: { select: { messages: true } }, assignment: { select: { email: true, user: { select: { name: true } }, project: { select: { name: true } }, stage: { select: { stageKey: true } } } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, status: row.status, kind: row.kind, outcome: row.outcome, openedBySide: row.openedBySide, claimAmount: tenge(row.claimAmountTiyn), createdAt: row.createdAt, messages: row._count.messages,
        project: row.assignment.project.name, stage: stageTitle(row.assignment.stage.stageKey), specialist: row.assignment.user?.name || row.assignment.email,
      })),
    };
  }

  /** Everything staff need to decide: the thread, the terms, money and the stage history around the assignment. */
  async staffDetail(staffId: string, disputeId: string) {
    if (!isUuid(disputeId)) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { ...disputeSelect, assignment: { select: { ...assignmentSelect, stageId: true, project: { select: { name: true, ownerUserId: true, owner: { select: { name: true, email: true } } } } } } } });
    if (!dispute) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const a = dispute.assignment;
    const [payments, time, versions, events] = await Promise.all([
      this.prisma.stagePayment.findMany({ where: { assignmentId: a.id }, orderBy: { createdAt: 'asc' }, select: { id: true, basis: true, amountTiyn: true, status: true, createdAt: true, heldAt: true, paidOutAt: true } }),
      this.prisma.timeEntry.findMany({ where: { assignmentId: a.id }, select: { startedAt: true, endedAt: true, status: true, actions: true, source: true } }),
      this.prisma.stageArtifactVersion.count({ where: { stageId: a.stageId } }),
      this.prisma.projectEvent.findMany({ where: { projectId: a.projectId, OR: [{ stageKey: a.stage.stageKey }, { type: { startsWith: 'dispute_' } }] }, orderBy: { createdAt: 'desc' }, take: 60, select: { type: true, createdAt: true, details: true, actorUserId: true } }),
    ]);
    const minutesBy: Record<string, number> = {};
    for (const entry of time) minutesBy[entry.status] = (minutesBy[entry.status] ?? 0) + Math.round((entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000);
    // Reading the evidence of a money decision is itself recorded.
    await this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'dispute.viewed', targetType: 'dispute', targetId: disputeId, details: {} } });
    return {
      data: {
        ...this.view(dispute, 'staff'),
        project: a.project.name, owner: a.project.owner.name || a.project.owner.email, specialist: a.user?.name || a.email, stage: stageTitle(a.stage.stageKey), role: a.role,
        assignment: { status: a.status, acceptedAt: a.acceptedAt, completedAt: a.completedAt, revokedAt: a.revokedAt, payKind: a.payKind, fixedAmount: tenge(a.fixedAmountTiyn), hourlyRate: tenge(a.hourlyRateTiyn), hourLimit: a.hourLimit },
        payments: payments.map((payment) => ({ id: payment.id, basis: payment.basis, amount: tenge(payment.amountTiyn), status: payment.status, createdAt: payment.createdAt, heldAt: payment.heldAt, paidOutAt: payment.paidOutAt })),
        time: { minutesByStatus: minutesBy, entries: time.length, withoutActions: time.filter((entry) => entry.actions === 0 && entry.source === 'tracked').length },
        stageVersions: versions,
        events: events.map((event) => ({ type: event.type, createdAt: event.createdAt, details: event.details, by: event.actorUserId === a.project.ownerUserId ? 'owner' : event.actorUserId && event.actorUserId === a.userId ? 'specialist' : event.actorUserId ? 'member' : 'system' })),
      },
    };
  }

  async staffMessage(staffId: string, disputeId: string, text: unknown) {
    if (!isUuid(disputeId)) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { status: true, _count: { select: { messages: true } }, assignment: { select: { userId: true, project: { select: { ownerUserId: true, name: true } }, stage: { select: { stageKey: true } } } } } });
    if (!dispute) throw new NotFoundException('DISPUTE_NOT_FOUND');
    if (dispute.status !== 'open') throw new ConflictException('DISPUTE_CLOSED');
    const checked = checkMessage(text, dispute._count.messages);
    if (!checked.ok) throw new BadRequestException(checked.code);
    await this.prisma.$transaction([
      this.prisma.disputeMessage.create({ data: { disputeId, side: 'staff', staffId, text: checked.text } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'dispute.message', targetType: 'dispute', targetId: disputeId, details: {} } }),
    ]);
    const text2 = () => tr('Поддержка BuildPath написала в споре по этапу «{0}» проекта «{1}».', [tr(stageTitle(dispute.assignment.stage.stageKey)), dispute.assignment.project.name]);
    await Promise.all([this.notify(dispute.assignment.userId, text2), this.notify(dispute.assignment.project.ownerUserId, text2)]);
    return this.staffDetail(staffId, disputeId);
  }

  /** Staff decision, final for the platform. Optionally creates an amount due from the owner to the specialist. */
  async resolve(staffId: string, disputeId: string, input: { outcome: unknown; note: unknown; paySpecialist: unknown }) {
    if (!isUuid(disputeId)) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const checked = checkResolution(input);
    if (!checked.ok) throw new BadRequestException(checked.code);
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { assignmentId: true, projectId: true, assignment: { select: { userId: true, project: { select: { ownerUserId: true, name: true } }, stage: { select: { stageKey: true } } } } } });
    if (!dispute) throw new NotFoundException('DISPUTE_NOT_FOUND');
    if (checked.payTiyn !== null && !dispute.assignment.userId) throw new ConflictException('DISPUTE_PAYMENT_NOT_ALLOWED');
    await this.prisma.$transaction(async (tx) => {
      const closed = await tx.dispute.updateMany({ where: { id: disputeId, status: 'open' }, data: { status: 'resolved', outcome: checked.outcome, resolutionNote: checked.note, resolvedByStaffId: staffId, resolvedAt: new Date() } });
      if (!closed.count) throw new ConflictException('DISPUTE_CLOSED');
      let paymentId: string | null = null;
      if (checked.payTiyn !== null) {
        paymentId = (await tx.stagePayment.create({ data: { assignmentId: dispute.assignmentId, projectId: dispute.projectId, basis: 'dispute', amountTiyn: checked.payTiyn }, select: { id: true } })).id;
        await tx.dispute.update({ where: { id: disputeId }, data: { resultPaymentId: paymentId } });
      }
      await tx.adminAuditEvent.create({ data: { staffId, eventType: 'dispute.resolved', targetType: 'dispute', targetId: disputeId, details: { outcome: checked.outcome, paySpecialist: tenge(checked.payTiyn), paymentId } } });
      await tx.projectEvent.create({ data: { projectId: dispute.projectId, type: 'dispute_resolved', stageKey: dispute.assignment.stage.stageKey, details: { disputeId, outcome: checked.outcome, paySpecialist: tenge(checked.payTiyn) } } });
    });
    const title = stageTitle(dispute.assignment.stage.stageKey);
    const message = () => tr('Поддержка BuildPath решила спор по этапу «{0}» проекта «{1}»: {2}', [tr(title), dispute.assignment.project.name, checked.note]);
    await Promise.all([this.notify(dispute.assignment.userId, message), this.notify(dispute.assignment.project.ownerUserId, message)]);
    return this.staffDetail(staffId, disputeId);
  }
}

/** True while a dispute about this assignment is open: BuildPath does not transfer its money then. */
export async function hasOpenDispute(prisma: Pick<PrismaService, 'dispute'>, assignmentId: string): Promise<boolean> {
  return (await prisma.dispute.count({ where: { assignmentId, status: 'open' } })) > 0;
}
