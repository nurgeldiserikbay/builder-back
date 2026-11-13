import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { tr } from '../i18n/i18n.js';
import { billingSettings, projectBalance } from '../payments/wallet.js';

export const OFFER_DAYS = 7;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** What has to be settled before a project can change hands, in plain words. Money and credentials never move silently. */
export const blockerTexts: Record<string, string> = {
  WALLET_NOT_EMPTY: 'На балансе проекта есть деньги прежнего владельца. Потратьте их или попросите вернуть остаток.',
  TOP_UP_IN_PROGRESS: 'Идёт пополнение баланса. Дождитесь, пока оно завершится.',
  PAYMENTS_OPEN: 'Есть неоплаченная или удержанная оплата специалисту. Сначала завершите расчёты.',
  DISPUTE_OPEN: 'Идёт спор со специалистом. Сначала его нужно закрыть.',
  REPOSITORY_CONNECTED: 'Подключён репозиторий с доступом прежнего владельца. Отключите его — новый владелец подключит свой.',
};

/**
 * Handing a project to another member. The owner offers, the recipient accepts within 7 days; until then nothing changes.
 * The project moves to the recipient's workspace and counts on their plan. The previous owner stays as a manager or
 * leaves, as chosen in the offer. A transfer is refused while money or credentials of the previous owner are tied to the
 * project (balance, payments to specialists, a dispute, a connected repository).
 */
@Injectable()
export class OwnershipService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService) {}

  async blockers(projectId: string): Promise<string[]> {
    const settings = await billingSettings(this.prisma);
    const [balance, creating, payments, disputes, repository] = await Promise.all([
      projectBalance(this.prisma, projectId, settings.prepaidSince),
      this.prisma.projectTopUp.count({ where: { projectId, status: 'created', createdAt: { gt: new Date(Date.now() - 3600_000) } } }),
      this.prisma.stagePayment.count({ where: { projectId, status: { in: ['due', 'checkout', 'held'] } } }),
      this.prisma.dispute.count({ where: { status: 'open', assignment: { projectId } } }),
      this.prisma.codeRepository.count({ where: { projectId } }),
    ]);
    const codes: string[] = [];
    if (balance.balanceTiyn > 0 || balance.pendingRefundTiyn > 0) codes.push('WALLET_NOT_EMPTY');
    if (creating) codes.push('TOP_UP_IN_PROGRESS');
    if (payments) codes.push('PAYMENTS_OPEN');
    if (disputes) codes.push('DISPUTE_OPEN');
    if (repository) codes.push('REPOSITORY_CONNECTED');
    return codes;
  }

  private async member(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const row = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true, project: { select: { id: true, name: true, status: true, ownerUserId: true } } } });
    if (!row) throw new NotFoundException('PROJECT_NOT_FOUND');
    return row;
  }

  private async pending(projectId: string) {
    const offer = await this.prisma.ownershipTransfer.findFirst({ where: { projectId, status: 'pending' } });
    if (offer && offer.expiresAt < new Date()) {
      await this.prisma.ownershipTransfer.updateMany({ where: { id: offer.id, status: 'pending' }, data: { status: 'expired', decidedAt: new Date() } });
      return null;
    }
    return offer;
  }

  /** For the team card: the open offer (to the owner and the recipient) and, for the owner, what blocks a transfer. */
  async view(userId: string, projectId: string, role: string) {
    const offer = await this.pending(projectId);
    const owner = role === 'owner';
    const visible = offer && (owner || offer.toUserId === userId) ? offer : null;
    const recipient = visible ? await this.prisma.user.findUnique({ where: { id: visible.toUserId }, select: { name: true, email: true } }) : null;
    const blockers = owner || visible ? await this.blockers(projectId) : [];
    return {
      offer: visible ? { id: visible.id, toUserId: visible.toUserId, toName: recipient?.name || recipient?.email || '', keepAccess: visible.keepAccess, expiresAt: visible.expiresAt, forYou: visible.toUserId === userId } : null,
      canOffer: owner && !offer,
      blockers: blockers.map((code) => ({ code, text: tr(blockerTexts[code] ?? code) })),
    };
  }

  /** The open offer to this person, with what they would take on — for the Telegram bot. Null when there is none. */
  async forRecipient(userId: string, projectId: string) {
    const { project } = await this.member(userId, projectId);
    const offer = await this.pending(projectId);
    if (!offer || offer.toUserId !== userId) return null;
    const from = await this.prisma.user.findUnique({ where: { id: offer.fromUserId }, select: { name: true, email: true } });
    const blockers = await this.blockers(projectId);
    return { projectName: project.name, fromName: from?.name || from?.email || '', keepAccess: offer.keepAccess, expiresAt: offer.expiresAt, blockers: blockers.map((code) => tr(blockerTexts[code] ?? code)) };
  }

  async offer(userId: string, projectId: string, input: { toMemberId: string; keepAccess: boolean; confirmName: string }) {
    const { role, project } = await this.member(userId, projectId);
    if (role !== 'owner') throw new ForbiddenException('OWNERSHIP_OWNER_ONLY');
    if (project.status === 'archived') throw new ConflictException('PROJECT_NOT_ACTIVE');
    if (input.confirmName.trim() !== project.name.trim()) throw new BadRequestException('OWNERSHIP_CONFIRM_NAME');
    if (!isUuid(input.toMemberId)) throw new NotFoundException('MEMBER_NOT_FOUND');
    const target = await this.prisma.projectMember.findFirst({ where: { id: input.toMemberId, projectId, status: 'active' }, select: { userId: true, role: true } });
    if (!target) throw new NotFoundException('MEMBER_NOT_FOUND');
    if (target.userId === userId) throw new ConflictException('CANNOT_CHANGE_SELF');
    if (target.role === 'viewer') throw new BadRequestException('OWNERSHIP_TARGET_VIEWER');
    const blockers = await this.blockers(projectId);
    if (blockers.length) throw new ConflictException({ message: 'OWNERSHIP_BLOCKED', blockers });
    if (await this.pending(projectId)) throw new ConflictException('OWNERSHIP_OFFER_OPEN');
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.ownershipTransfer.create({ data: { projectId, fromUserId: userId, toUserId: target.userId, keepAccess: input.keepAccess, expiresAt: new Date(Date.now() + OFFER_DAYS * 86_400_000) } });
        await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ownership_offered', details: { transferId: created.id, toUserId: target.userId, keepAccess: input.keepAccess } } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('OWNERSHIP_OFFER_OPEN');
      throw error;
    }
    const from = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await notifyUser(this.prisma, target.userId, {
      text: () => tr('{0} предлагает передать вам проект «{1}». Посмотрите условия и примите или откажитесь во вкладке «Команда» в течение 7 дней.', [from?.name || from?.email || '', project.name]),
      // In Telegram the offer can be read and answered right in the chat.
      telegramKeyboard: () => [[{ text: tr('📦 Посмотреть предложение'), callback_data: `OT:${projectId}` }]],
    }).catch(() => undefined);
    return { data: { offered: true } };
  }

  async cancel(userId: string, projectId: string) {
    const { role } = await this.member(userId, projectId);
    if (role !== 'owner') throw new ForbiddenException('OWNERSHIP_OWNER_ONLY');
    const offer = await this.pending(projectId);
    if (!offer) throw new NotFoundException('OWNERSHIP_OFFER_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.ownershipTransfer.updateMany({ where: { id: offer.id, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } });
      if (done.count !== 1) throw new GoneException('OWNERSHIP_OFFER_NOT_FOUND');
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ownership_cancelled', details: { transferId: offer.id } } });
    });
    return { data: { cancelled: true } };
  }

  async decline(userId: string, projectId: string) {
    const { project } = await this.member(userId, projectId);
    const offer = await this.pending(projectId);
    if (!offer || offer.toUserId !== userId) throw new NotFoundException('OWNERSHIP_OFFER_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.ownershipTransfer.updateMany({ where: { id: offer.id, status: 'pending' }, data: { status: 'declined', decidedAt: new Date() } });
      if (done.count !== 1) throw new GoneException('OWNERSHIP_OFFER_NOT_FOUND');
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ownership_declined', details: { transferId: offer.id } } });
    });
    await notifyUser(this.prisma, offer.fromUserId, { text: () => tr('Передача проекта «{0}» отклонена.', [project.name]) }).catch(() => undefined);
    return { data: { declined: true } };
  }

  /** The recipient takes the project. Everything is checked again under a lock on the project. */
  async accept(userId: string, projectId: string) {
    const { project } = await this.member(userId, projectId);
    const offer = await this.pending(projectId);
    if (!offer || offer.toUserId !== userId) throw new NotFoundException('OWNERSHIP_OFFER_NOT_FOUND');
    const blockers = await this.blockers(projectId);
    if (blockers.length) throw new ConflictException({ message: 'OWNERSHIP_BLOCKED', blockers });
    const full = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { projectType: true, status: true, publication: { select: { status: true } } } });
    const others = await this.prisma.projectMember.count({ where: { projectId, status: 'active', userId: { notIn: [userId, offer.fromUserId] } } });
    await this.billing.assertCanReceiveProject(userId, { counts: Boolean(full.projectType) && full.status !== 'archived', live: full.publication?.status === 'live', team: others > 0 || offer.keepAccess });
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ownership:${projectId}`}))`;
      const taken = await tx.ownershipTransfer.updateMany({ where: { id: offer.id, status: 'pending', expiresAt: { gt: new Date() } }, data: { status: 'accepted', decidedAt: new Date() } });
      if (taken.count !== 1) throw new GoneException('OWNERSHIP_OFFER_NOT_FOUND');
      const current = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { ownerUserId: true } });
      if (current.ownerUserId !== offer.fromUserId) throw new GoneException('OWNERSHIP_OFFER_NOT_FOUND');
      let workspace = await tx.workspace.findFirst({ where: { ownerUserId: userId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (!workspace) {
        workspace = await tx.workspace.create({ data: { ownerUserId: userId, name: tr('Мои проекты') }, select: { id: true } });
        await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role: 'owner', status: 'active' } });
      }
      await tx.project.update({ where: { id: projectId }, data: { ownerUserId: userId, workspaceId: workspace.id } });
      await tx.projectMember.updateMany({ where: { projectId, userId }, data: { role: 'owner', stageKeys: [] } });
      await tx.projectMember.updateMany({ where: { projectId, userId: offer.fromUserId }, data: offer.keepAccess ? { role: 'manager', stageKeys: [] } : { status: 'revoked' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ownership_transferred', details: { transferId: offer.id, fromUserId: offer.fromUserId, toUserId: userId, keepAccess: offer.keepAccess } } });
    });
    const to = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await notifyUser(this.prisma, offer.fromUserId, { text: () => (offer.keepAccess
      ? tr('{0} принял(а) проект «{1}». Теперь вы администратор этого проекта.', [to?.name || to?.email || '', project.name])
      : tr('{0} принял(а) проект «{1}». У вас больше нет доступа к нему.', [to?.name || to?.email || '', project.name])) }).catch(() => undefined);
    return { data: { projectId } };
  }
}
