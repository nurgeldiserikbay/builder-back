import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { scanRequired, scanWithClamAv } from '../security/clamav.js';
import { processImage } from '../images/image-processing.js';
import { cleanFileName, detectStageFile } from '../analysis/file-types.js';

import { PrismaService } from '../database/prisma.service.js';
import { tr, type Message } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';
import { ANSWER_DAYS, MAX_MESSAGES, REVOKED_WINDOW_DAYS, canOpen, checkClaim, checkMessage, checkResolution, kindsBySide, sideOf, waitingFor, type Side } from './dispute-rules.js';

/** Evidence files in a dispute: screenshots and PDFs, 5 MB each, 10 per dispute. */
const DISPUTE_FILE_BYTES = 5 * 1024 * 1024;
const DISPUTE_FILES = 10;

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
  messages: { orderBy: { createdAt: 'asc' as const }, select: { id: true, side: true, text: true, createdAt: true, fileName: true, fileMime: true, fileBytes: true } },
} as const;

type DisputeRow = { id: string; assignmentId: string; projectId: string; openedBySide: string; kind: string; claim: string; claimAmountTiyn: number | null; status: string; outcome: string | null; resolutionNote: string | null; resolvedAt: Date | null; resultPaymentId: string | null; createdAt: Date; messages: Array<{ id: string; side: string; text: string; createdAt: Date; fileName: string | null; fileMime: string | null; fileBytes: number | null }> };

/**
 * Disputes between a project owner and a specialist. Both sides see the same thread; neither sees the other's account
 * details. Staff decide from the stage history. While a dispute is open, BuildPath does not transfer money for that
 * assignment (checked in PaymentsService before a payout).
 */
@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Telegram when linked, and e-mail for the steps that matter (opened, support wrote, decided, withdrawn) so a side
   * without Telegram still learns about them. Replies between the sides go to Telegram only, to keep mail quiet.
   */
  private notify(userId: string | null, text: Message, byEmail = true) {
    return notifyUser(this.prisma, userId, byEmail ? { text, emailSubject: () => tr('BuildPath: спор по работе специалиста'), link: { path: '/account/disputes', label: () => tr('Открыть споры') } } : { text });
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
      messages: row.messages.map((message) => ({ id: message.id, side: message.side, mine: message.side === side, text: message.text, createdAt: message.createdAt, file: message.fileName ? { name: message.fileName, mime: message.fileMime, bytes: message.fileBytes } : null })),
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
    await this.notify(this.otherSide(side, assignment), () => tr('По этапу «{0}» в проекте «{1}» открыт спор. Поддержка BuildPath разберёт его по истории этапа; вы можете добавить своё объяснение в разделе «Споры».', [tr(title), assignment.project.name]));
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
    await this.notify(this.otherSide(side, assignment), () => tr('Новое сообщение в споре по этапу «{0}» проекта «{1}».', [tr(stageTitle(assignment.stage.stageKey)), assignment.project.name]), false);
    return this.forAssignment(userId, dispute.assignmentId);
  }

  /**
   * A screenshot or a PDF as evidence. Scanned first (fail closed); a photo is decoded and re-encoded to WebP, which
   * drops metadata such as location. At most 10 files per dispute, counted with the messages.
   */
  async attach(userId: string, disputeId: string, file: { buffer: Buffer; size: number; originalname?: string } | undefined, text: unknown) {
    const { dispute, assignment, side } = await this.disputeFor(userId, disputeId);
    if (dispute.status !== 'open') throw new ConflictException('DISPUTE_CLOSED');
    if (!file?.buffer?.length) throw new BadRequestException('FILE_REQUIRED');
    if (file.size > DISPUTE_FILE_BYTES) throw new UnprocessableEntityException('FILE_TOO_LARGE');
    const name = cleanFileName(file.originalname) ?? 'file';
    const type = detectStageFile(file.buffer, name);
    if (!type || (type.kind !== 'image' && type.kind !== 'pdf')) throw new UnprocessableEntityException('DISPUTE_FILE_TYPE');
    const files = await this.prisma.disputeMessage.count({ where: { disputeId, fileName: { not: null } } });
    if (files >= DISPUTE_FILES) throw new ConflictException('DISPUTE_TOO_MANY_FILES');
    const caption = text === undefined || text === null || text === '' ? null : checkMessage(text, dispute._count.messages);
    if (caption && !caption.ok) throw new BadRequestException(caption.code);
    if (!caption && dispute._count.messages >= MAX_MESSAGES) throw new BadRequestException('DISPUTE_TOO_MANY_MESSAGES');
    if (scanRequired()) {
      const scan = await scanWithClamAv(file.buffer);
      if (scan === 'infected') throw new UnprocessableEntityException('FILE_REJECTED_BY_SCAN');
      if (scan === 'unavailable') throw new ServiceUnavailableException('FILE_SCAN_UNAVAILABLE');
    }
    let data = file.buffer; let mime = type.mime; let fileName = name;
    if (type.kind === 'image') {
      try { data = (await processImage(file.buffer)).data; } catch { throw new UnprocessableEntityException('IMAGE_UNREADABLE'); }
      mime = 'image/webp'; fileName = name.replace(/\.[a-z0-9]+$/i, '') + '.webp';
    }
    await this.prisma.disputeMessage.create({ data: {
      disputeId, side, authorUserId: userId, text: caption?.ok ? caption.text : `📎 ${fileName}`.slice(0, 2000),
      fileName, fileMime: mime, fileBytes: data.length, fileSha256: createHash('sha256').update(data).digest('hex'), fileData: new Uint8Array(data),
    } });
    await this.notify(this.otherSide(side, assignment), () => tr('Новое сообщение в споре по этапу «{0}» проекта «{1}».', [tr(stageTitle(assignment.stage.stageKey)), assignment.project.name]), false);
    return this.forAssignment(userId, dispute.assignmentId);
  }

  /** A file of a dispute message for its sides (or staff, with staff = true). */
  async file(userId: string | null, disputeId: string, messageId: string) {
    if (!isUuid(disputeId) || !isUuid(messageId)) throw new NotFoundException('FILE_NOT_FOUND');
    if (userId) await this.disputeFor(userId, disputeId);
    const row = await this.prisma.disputeMessage.findFirst({ where: { id: messageId, disputeId, fileName: { not: null } }, select: { fileName: true, fileMime: true, fileData: true, fileSha256: true } });
    if (!row?.fileData) throw new NotFoundException('FILE_NOT_FOUND');
    return { name: row.fileName!, mime: row.fileMime ?? 'application/octet-stream', data: Buffer.from(row.fileData), etag: row.fileSha256 ?? '' };
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
    // A specialist whose access is over can no longer open the stage page, so the account lists where a dispute is still possible.
    const now = new Date();
    const since = new Date(now.getTime() - REVOKED_WINDOW_DAYS * 86_400_000);
    const closedAccess = await this.prisma.stageAssignment.findMany({
      where: {
        userId, acceptedAt: { not: null }, disputes: { none: { status: 'open' } },
        OR: [{ status: 'revoked', revokedAt: { gt: since } }, { status: 'completed', completedAt: { gt: since }, OR: [{ readUntil: null }, { readUntil: { lte: now } }] }],
      },
      orderBy: { updatedAt: 'desc' }, take: 20,
      select: { id: true, status: true, project: { select: { name: true } }, stage: { select: { stageKey: true } } },
    });
    return {
      data: {
        disputes: rows.map((row) => ({
          id: row.id, status: row.status, kind: row.kind, outcome: row.outcome, createdAt: row.createdAt, projectId: row.assignment.projectId, projectName: row.assignment.project.name,
          stageKey: row.assignment.stage.stageKey, stageTitle: stageTitle(row.assignment.stage.stageKey), side: row.assignment.userId === userId ? 'specialist' : 'owner',
        })),
        withoutStageAccess: closedAccess.map((row) => ({ assignmentId: row.id, projectName: row.project.name, stageTitle: stageTitle(row.stage.stageKey), status: row.status })),
      },
    };
  }

  /** Reminds, once, the side that has not answered an open dispute for ANSWER_DAYS. Called by DisputeRemindersService. */
  async processReminders(now = new Date()): Promise<number> {
    const due = await this.prisma.dispute.findMany({
      where: { status: 'open', remindedAt: null, createdAt: { lte: new Date(now.getTime() - ANSWER_DAYS * 86_400_000) } }, take: 200,
      select: { id: true, status: true, openedBySide: true, createdAt: true, remindedAt: true, messages: { select: { side: true } }, assignment: { select: { userId: true, project: { select: { ownerUserId: true, name: true } }, stage: { select: { stageKey: true } } } } },
    });
    let sent = 0;
    for (const dispute of due) {
      const waiting = waitingFor(dispute, now);
      if (!waiting.remind || !waiting.side) continue;
      // Claim the reminder first, so a second instance or a retry never sends it twice.
      const claimed = await this.prisma.dispute.updateMany({ where: { id: dispute.id, remindedAt: null, status: 'open' }, data: { remindedAt: now } });
      if (!claimed.count) continue;
      const recipient = waiting.side === 'owner' ? dispute.assignment.project.ownerUserId : dispute.assignment.userId;
      await this.notify(recipient, () => tr('Вы ещё не ответили в споре по этапу «{0}» проекта «{1}». Опишите свою сторону — иначе поддержка BuildPath решит спор по тому, что есть.', [tr(stageTitle(dispute.assignment.stage.stageKey)), dispute.assignment.project.name]));
      sent += 1;
    }
    return sent;
  }

  // --- Staff ---

  async staffQueue(status: string) {
    const filter = status === 'closed' ? { status: { in: ['resolved', 'withdrawn'] } } : { status: 'open' };
    const rows = await this.prisma.dispute.findMany({
      where: filter, orderBy: { createdAt: status === 'closed' ? 'desc' : 'asc' }, take: 100,
      select: { id: true, status: true, kind: true, outcome: true, openedBySide: true, claimAmountTiyn: true, createdAt: true, remindedAt: true, messages: { select: { side: true } }, _count: { select: { messages: true } }, assignment: { select: { email: true, user: { select: { name: true } }, project: { select: { name: true } }, stage: { select: { stageKey: true } } } } },
    });
    return {
      data: rows.map((row) => ({
        id: row.id, status: row.status, kind: row.kind, outcome: row.outcome, openedBySide: row.openedBySide, claimAmount: tenge(row.claimAmountTiyn), createdAt: row.createdAt, messages: row._count.messages,
        waiting: (({ side, days }) => (side ? { side, days, reminded: Boolean(row.remindedAt) } : null))(waitingFor(row)),
        project: row.assignment.project.name, stage: stageTitle(row.assignment.stage.stageKey), specialist: row.assignment.user?.name || row.assignment.email,
      })),
    };
  }

  /** Everything staff need to decide: the thread, the terms, money and the stage history around the assignment. */
  async staffDetail(staffId: string, disputeId: string) {
    if (!isUuid(disputeId)) throw new NotFoundException('DISPUTE_NOT_FOUND');
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { ...disputeSelect, remindedAt: true, assignment: { select: { ...assignmentSelect, stageId: true, project: { select: { name: true, ownerUserId: true, owner: { select: { name: true, email: true } } } } } } } });
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
        waiting: (({ side, days }) => (side ? { side, days, reminded: Boolean(dispute.remindedAt) } : null))(waitingFor(dispute)),
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
