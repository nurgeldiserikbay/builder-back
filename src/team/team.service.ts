import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { emailConfig, sendEmail } from '../notifications/email.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { tr } from '../i18n/i18n.js';
import { projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { canManage, INVITABLE_ROLES, INVITE_DAYS, readPolicy, roleInfo, TEAM_LIMIT, type InvitableRole, type ProjectRole } from './team-rules.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const email = (value: string) => value.trim().toLowerCase();

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService) {}

  private async membership(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({
      where: { projectId, userId, status: 'active' },
      select: { role: true, project: { select: { id: true, name: true, status: true, ownerUserId: true, projectType: true, owner: { select: { name: true, email: true } } } } },
    });
    if (!member) throw new NotFoundException('PROJECT_NOT_FOUND');
    return { role: member.role as ProjectRole, project: member.project };
  }

  private async manager(userId: string, projectId: string) {
    const found = await this.membership(userId, projectId);
    if (found.role !== 'owner' && found.role !== 'manager') throw new ForbiddenException('TEAM_MANAGE_FORBIDDEN');
    return found;
  }

  /** Stage keys of the project route, for limiting a contributor to some stages. */
  private routeStages(projectType: string | null) {
    return (projectTypeOf(projectType)?.stages ?? []).map((key) => ({ key, title: stageDefinitions[key].title }));
  }

  /** Checks stage keys against the route; only contributors are limited to stages. */
  private stageKeysFor(role: string, keys: unknown, projectType: string | null): string[] {
    if (keys === undefined || keys === null) return [];
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw new BadRequestException('STAGE_KEYS_INVALID');
    if (role !== 'contributor' && keys.length) throw new BadRequestException('STAGE_KEYS_ONLY_FOR_CONTRIBUTORS');
    const route = new Set(this.routeStages(projectType).map((stage) => stage.key as string));
    const unique = [...new Set(keys as string[])];
    if (unique.some((key) => !route.has(key))) throw new BadRequestException('STAGE_KEYS_INVALID');
    return unique;
  }

  /** The team as the viewer may see it: managers see addresses and invitations, everyone else names and roles. */
  async list(userId: string, projectId: string) {
    const { role, project } = await this.membership(userId, projectId);
    const managing = role === 'owner' || role === 'manager';
    const [members, invitations] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId, status: 'active' }, orderBy: { createdAt: 'asc' },
        select: { id: true, userId: true, role: true, stageKeys: true, createdAt: true, user: { select: { name: true, email: true } } },
      }),
      managing ? this.prisma.projectInvitation.findMany({
        where: { projectId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, email: true, role: true, stageKeys: true, expiresAt: true, createdAt: true },
      }) : Promise.resolve([]),
    ]);
    const now = new Date();
    return {
      data: {
        viewerRole: role,
        canManage: managing,
        limit: TEAM_LIMIT,
        stages: this.routeStages(project.projectType),
        roles: (Object.keys(roleInfo) as ProjectRole[]).map((key) => ({ key, title: roleInfo[key].title, explanation: roleInfo[key].explanation, invitable: managing && (INVITABLE_ROLES as readonly string[]).includes(key) && canManage(role, key) })),
        members: members.map((row) => ({
          id: row.id, userId: row.userId, role: row.role, roleTitle: roleInfo[row.role as ProjectRole].title, you: row.userId === userId, stageKeys: row.stageKeys,
          name: row.user.name || (managing ? row.user.email : tr('Участник')), email: managing ? row.user.email : null, since: row.createdAt,
          canChange: managing && row.userId !== userId && canManage(role, row.role),
        })),
        invitations: invitations.map((row) => ({ ...row, roleTitle: roleInfo[row.role as ProjectRole].title, expired: row.expiresAt < now })),
      },
    };
  }

  /** Projects of other people where this user is in the team (their own projects are listed per workspace). */
  async shared(userId: string) {
    const rows = await this.prisma.projectMember.findMany({
      where: { userId, status: 'active', role: { not: 'owner' }, project: { status: { not: 'archived' } } }, orderBy: { updatedAt: 'desc' }, take: 100,
      select: { role: true, project: { select: { id: true, name: true, status: true, projectType: true, updatedAt: true, owner: { select: { name: true } } } } },
    });
    return { data: rows.map(({ role, project: { owner, ...project } }) => ({ ...project, ownerName: owner.name, role, roleTitle: roleInfo[role as ProjectRole].title })) };
  }

  async invite(userId: string, projectId: string, input: { email: string; role: string; stageKeys?: unknown }) {
    const { role, project } = await this.manager(userId, projectId);
    if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) throw new BadRequestException('ROLE_INVALID');
    const target = input.role as InvitableRole;
    const stageKeys = this.stageKeysFor(target, input.stageKeys, project.projectType);
    if (!canManage(role, target)) throw new ForbiddenException('ROLE_NOT_ALLOWED');
    if (!['active', 'live', 'paused', 'draft'].includes(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    await this.billing.assertCanInviteTeam(projectId);
    const address = email(input.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) throw new BadRequestException('EMAIL_INVALID');
    const [active, open, existing] = await Promise.all([
      this.prisma.projectMember.count({ where: { projectId, status: 'active' } }),
      this.prisma.projectInvitation.findMany({ where: { projectId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { email: true } }),
      this.prisma.projectMember.findFirst({ where: { projectId, status: 'active', user: { emailNormalized: address } }, select: { id: true } }),
    ]);
    if (existing) throw new ConflictException('ALREADY_PROJECT_MEMBER');
    if (open.some((row) => row.email === address)) throw new ConflictException('ALREADY_INVITED');
    if (active + open.length >= TEAM_LIMIT) throw new ConflictException('TEAM_LIMIT_REACHED');
    const token = randomBytes(24).toString('base64url');
    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.projectInvitation.create({
        data: { projectId, email: address, role: target, stageKeys, tokenHash: digest(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000), invitedByUserId: userId },
        select: { id: true, email: true, role: true, stageKeys: true, expiresAt: true, createdAt: true },
      });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'team_invited', details: { invitationId: created.id, role: target } } });
      return created;
    });
    const inviteUrl = new URL(`/team-invite/${token}`, process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').toString();
    const mail = emailConfig();
    const inviter = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const emailSent = mail ? await sendEmail(mail, address, tr('Приглашение в команду проекта «{0}»', [project.name]),
      tr('<p>{0} приглашает вас в команду проекта «{1}»: {2}.</p><p>{3}</p><p><a href="{4}">Открыть приглашение</a></p><p>Ссылка действует {5} дней.</p>', [
        escapeHtml(inviter?.name || inviter?.email || ''), escapeHtml(project.name), escapeHtml(tr(roleInfo[target].title).toLowerCase()), escapeHtml(tr(roleInfo[target].explanation)), escapeHtml(inviteUrl), INVITE_DAYS,
      ])).catch(() => false) : false;
    return { data: { invitation: { ...invitation, roleTitle: roleInfo[target].title, expired: false }, inviteUrl, emailSent } };
  }

  async revokeInvitation(userId: string, projectId: string, invitationId: string) {
    const { role } = await this.manager(userId, projectId);
    if (!isUuid(invitationId)) throw new NotFoundException('INVITATION_NOT_FOUND');
    const row = await this.prisma.projectInvitation.findFirst({ where: { id: invitationId, projectId, acceptedAt: null, revokedAt: null }, select: { id: true, role: true } });
    if (!row) throw new NotFoundException('INVITATION_NOT_FOUND');
    if (!canManage(role, row.role)) throw new ForbiddenException('ROLE_NOT_ALLOWED');
    await this.prisma.$transaction(async (tx) => {
      await tx.projectInvitation.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'team_invitation_revoked', details: { invitationId: row.id } } });
    });
    return this.list(userId, projectId);
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('INVITE_NOT_FOUND');
    const row = await this.prisma.projectInvitation.findUnique({
      where: { tokenHash: digest(token) },
      select: { id: true, email: true, role: true, stageKeys: true, expiresAt: true, acceptedAt: true, acceptedUserId: true, revokedAt: true, projectId: true, invitedByUserId: true, project: { select: { name: true, status: true, ownerUserId: true, projectType: true } } },
    });
    if (!row) throw new NotFoundException('INVITE_NOT_FOUND');
    return row;
  }

  /** What the invitation page shows before signing in: the project, the role and what it allows. No address of the inviter. */
  async info(token: string) {
    const row = await this.byToken(token);
    const inviter = await this.prisma.user.findUnique({ where: { id: row.invitedByUserId }, select: { name: true } });
    return {
      data: {
        projectName: row.project.name, invitedBy: inviter?.name ?? null, role: row.role, roleTitle: roleInfo[row.role as ProjectRole].title,
        roleExplanation: roleInfo[row.role as ProjectRole].explanation, expired: row.expiresAt < new Date(), revoked: Boolean(row.revokedAt), accepted: Boolean(row.acceptedAt),
        stages: row.stageKeys.map((key) => stageDefinitions[key as StageKey]?.title ?? key),
      },
    };
  }

  async accept(userId: string, userEmail: string, token: string) {
    const row = await this.byToken(token);
    if (row.acceptedAt && row.acceptedUserId === userId) return { data: { projectId: row.projectId } };
    if (row.acceptedAt || row.revokedAt) throw new GoneException('INVITE_NOT_AVAILABLE');
    if (row.expiresAt < new Date()) throw new GoneException('INVITE_EXPIRED');
    if (row.project.status === 'archived') throw new GoneException('INVITE_NOT_AVAILABLE');
    // Bound to the address it was sent to: a forwarded link does not let someone else in.
    if (email(userEmail) !== row.email) throw new ForbiddenException('INVITE_EMAIL_MISMATCH');
    await this.prisma.$transaction(async (tx) => {
      const taken = await tx.projectInvitation.updateMany({ where: { id: row.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date(), acceptedUserId: userId } });
      if (taken.count !== 1) throw new GoneException('INVITE_NOT_AVAILABLE');
      const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: row.projectId, userId } }, select: { id: true, status: true } });
      if (existing?.status === 'active') throw new ConflictException('ALREADY_PROJECT_MEMBER');
      // Someone removed earlier comes back with the new role; their old actions stay in the history.
      if (existing) await tx.projectMember.update({ where: { id: existing.id }, data: { role: row.role, status: 'active', stageKeys: row.stageKeys } });
      else await tx.projectMember.create({ data: { projectId: row.projectId, userId, role: row.role, status: 'active', stageKeys: row.stageKeys } });
      await tx.projectEvent.create({ data: { projectId: row.projectId, actorUserId: userId, type: 'team_joined', details: { invitationId: row.id, role: row.role } } });
    });
    const joined = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    await notifyUser(this.prisma, row.invitedByUserId, { text: () => tr('{0} присоединился к команде проекта «{1}» как {2}.', [joined?.name || joined?.email || '', row.project.name, tr(roleInfo[row.role as ProjectRole].title).toLowerCase()]) });
    return { data: { projectId: row.projectId } };
  }

  async changeRole(userId: string, projectId: string, memberId: string, nextRole: string) {
    const { role, project } = await this.manager(userId, projectId);
    if (!(INVITABLE_ROLES as readonly string[]).includes(nextRole)) throw new BadRequestException('ROLE_INVALID');
    const member = await this.target(userId, projectId, memberId, role);
    if (!canManage(role, nextRole)) throw new ForbiddenException('ROLE_NOT_ALLOWED');
    if (member.role === nextRole) return this.list(userId, projectId);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.update({ where: { id: member.id }, data: { role: nextRole as InvitableRole, ...(nextRole === 'contributor' ? {} : { stageKeys: [] }) } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'team_role_changed', details: { memberUserId: member.userId, from: member.role, to: nextRole } } });
    });
    await notifyUser(this.prisma, member.userId, { text: () => tr('Ваша роль в проекте «{0}» теперь: {1}.', [project.name, tr(roleInfo[nextRole as ProjectRole].title).toLowerCase()]) });
    return this.list(userId, projectId);
  }

  /** Limits a contributor to some stages, or (empty list) gives back every stage. */
  async setStages(userId: string, projectId: string, memberId: string, keys: unknown) {
    const { role, project } = await this.manager(userId, projectId);
    const member = await this.target(userId, projectId, memberId, role);
    const stageKeys = this.stageKeysFor(member.role, keys, project.projectType);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.update({ where: { id: member.id }, data: { stageKeys } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'team_stages_changed', details: { memberUserId: member.userId, stageKeys } } });
    });
    const titles = stageKeys.map((key) => stageDefinitions[key as StageKey].title);
    await notifyUser(this.prisma, member.userId, { text: () => (titles.length ? tr('В проекте «{0}» вы теперь работаете на этапах: {1}.', [project.name, titles.map((title) => tr(title)).join(', ')]) : tr('В проекте «{0}» вы теперь можете работать на всех этапах.', [project.name])) });
    return this.list(userId, projectId);
  }

  /** Removes access now; what the person did stays in the history. Approval policies that name them are reported to fix. */
  async remove(userId: string, projectId: string, memberId: string) {
    const { role, project } = await this.manager(userId, projectId);
    const member = await this.target(userId, projectId, memberId, role);
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.update({ where: { id: member.id }, data: { status: 'revoked' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'team_member_removed', details: { memberUserId: member.userId, role: member.role } } });
    });
    await notifyUser(this.prisma, member.userId, { text: () => tr('У вас больше нет доступа к проекту «{0}».', [project.name]) });
    const stages = await this.prisma.projectStage.findMany({ where: { projectId }, select: { stageKey: true, approvalPolicy: true } });
    const affected = stages.filter((stage) => readPolicy(stage.approvalPolicy)?.reviewers.includes(member.userId)).map((stage) => stage.stageKey);
    const list = await this.list(userId, projectId);
    return { data: { ...list.data, affectedStages: affected } };
  }

  private async target(userId: string, projectId: string, memberId: string, actorRole: ProjectRole) {
    if (!isUuid(memberId)) throw new NotFoundException('MEMBER_NOT_FOUND');
    const member = await this.prisma.projectMember.findFirst({ where: { id: memberId, projectId, status: 'active' }, select: { id: true, userId: true, role: true } });
    if (!member) throw new NotFoundException('MEMBER_NOT_FOUND');
    if (member.userId === userId) throw new ConflictException('CANNOT_CHANGE_SELF');
    if (!canManage(actorRole, member.role)) throw new ForbiddenException('ROLE_NOT_ALLOWED');
    return member;
  }
}
