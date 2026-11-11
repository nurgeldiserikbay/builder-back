// Masters of the booking route: the owner invites a master by e-mail, and the master then sees only their own bookings
// (client name, phone, comment) and marks visits. They see nothing else of the project and cannot cancel bookings.
import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { emailConfig, sendEmail } from '../notifications/email.js';
import { escapeHtml } from '../journey/site-renderer.js';
import type { BookingConfig } from '../journey/schedule.js';

const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const manageRoles = new Set(['owner', 'manager']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

@Injectable()
export class MastersService {
  constructor(private readonly prisma: PrismaService) {}

  private async manager(userId: string, projectId: string) {
    if (!uuid.test(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: { id: true, name: true, status: true, members: { where: { userId, status: 'active' }, select: { role: true } }, owner: { select: { name: true, email: true } }, publication: { select: { buildVersionId: true } } },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (!manageRoles.has(project.members[0]?.role ?? '')) throw new ForbiddenException('MASTERS_FORBIDDEN');
    return project;
  }

  /** Masters of the published schedule; bookings exist only for a published site. */
  private async scheduleMasters(buildVersionId: string | undefined) {
    if (!buildVersionId) return [];
    const version = await this.prisma.stageArtifactVersion.findUnique({ where: { id: buildVersionId }, select: { content: true } });
    const booking = (version?.content as { meta?: { booking?: BookingConfig } } | null)?.meta?.booking;
    return booking?.schedule.masters.map((master) => ({ key: master.key, name: master.name })) ?? [];
  }

  async list(userId: string, projectId: string) {
    const project = await this.manager(userId, projectId);
    const masters = await this.scheduleMasters(project.publication?.buildVersionId);
    const accesses = await this.prisma.masterAccess.findMany({ where: { projectId, status: { not: 'revoked' } }, select: { id: true, masterKey: true, email: true, status: true, inviteExpiresAt: true, acceptedAt: true } });
    const now = new Date();
    return {
      data: {
        published: Boolean(project.publication),
        masters: masters.map((master) => {
          const access = accesses.find((item) => item.masterKey === master.key);
          return {
            ...master,
            access: access ? { id: access.id, email: access.email, status: access.status, expired: access.status === 'invited' && access.inviteExpiresAt < now, acceptedAt: access.acceptedAt } : null,
          };
        }),
      },
    };
  }

  async invite(userId: string, projectId: string, masterKey: string, rawEmail: string) {
    const project = await this.manager(userId, projectId);
    if (!['active', 'live'].includes(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const master = (await this.scheduleMasters(project.publication?.buildVersionId)).find((item) => item.key === masterKey);
    if (!master) throw new NotFoundException('MASTER_NOT_FOUND');
    const email = rawEmail.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(email)) throw new BadRequestException('EMAIL_INVALID');
    const token = randomBytes(24).toString('base64url');
    const access = await this.prisma.$transaction(async (tx) => {
      // A new invitation replaces an unanswered or expired one for the same master.
      const open = await tx.masterAccess.findFirst({ where: { projectId, masterKey, status: { not: 'revoked' } }, select: { id: true, status: true } });
      if (open?.status === 'active') throw new ConflictException('MASTER_ALREADY_CONNECTED');
      if (open) await tx.masterAccess.update({ where: { id: open.id }, data: { status: 'revoked', revokedAt: new Date() } });
      const created = await tx.masterAccess.create({
        data: { projectId, masterKey, email, inviteTokenHash: digest(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedByUserId: userId },
        select: { id: true },
      });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'master_invited', details: { accessId: created.id, masterKey } } });
      return created;
    });
    const inviteUrl = new URL(`/master-invite/${token}`, process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').toString();
    const mail = emailConfig();
    const inviter = project.owner.name ?? project.owner.email;
    const emailSent = mail ? await sendEmail(mail, email, `Ваши записи в «${project.name}»`,
      `<p>${escapeHtml(inviter)} приглашает вас видеть свои записи клиентов в «${escapeHtml(project.name)}» как мастера «${escapeHtml(master.name)}».</p><p>Вы будете видеть только записи к вам: время, услугу, имя и телефон клиента. Новые записи можно получать в Telegram.</p><p><a href="${escapeHtml(inviteUrl)}">Открыть приглашение</a></p><p>Ссылка действует 7 дней.</p>`) : false;
    return { data: { accessId: access.id, inviteUrl, emailSent } };
  }

  async revoke(userId: string, projectId: string, accessId: string) {
    await this.manager(userId, projectId);
    if (!uuid.test(accessId)) throw new NotFoundException('MASTER_ACCESS_NOT_FOUND');
    const access = await this.prisma.masterAccess.findFirst({ where: { id: accessId, projectId, status: { not: 'revoked' } }, select: { id: true, masterKey: true } });
    if (!access) throw new NotFoundException('MASTER_ACCESS_NOT_FOUND');
    await this.prisma.$transaction([
      this.prisma.masterAccess.update({ where: { id: access.id }, data: { status: 'revoked', revokedAt: new Date() } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'master_revoked', details: { accessId, masterKey: access.masterKey } } }),
    ]);
    return this.list(userId, projectId);
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('INVITE_NOT_FOUND');
    const access = await this.prisma.masterAccess.findUnique({
      where: { inviteTokenHash: digest(token) },
      select: { id: true, projectId: true, masterKey: true, email: true, userId: true, status: true, inviteExpiresAt: true, project: { select: { name: true, owner: { select: { name: true, email: true } }, publication: { select: { buildVersionId: true } } } } },
    });
    if (!access) throw new NotFoundException('INVITE_NOT_FOUND');
    return access;
  }

  async inviteInfo(token: string) {
    const access = await this.byToken(token);
    const master = (await this.scheduleMasters(access.project.publication?.buildVersionId)).find((item) => item.key === access.masterKey);
    return {
      data: {
        projectName: access.project.name, invitedBy: access.project.owner.name ?? maskEmail(access.project.owner.email), masterName: master?.name ?? null,
        email: maskEmail(access.email), status: access.status, expired: access.status === 'invited' && access.inviteExpiresAt < new Date(),
      },
    };
  }

  async accept(userId: string, userEmail: string, token: string) {
    const access = await this.byToken(token);
    if (access.status === 'active' && access.userId === userId) return { data: { ok: true } };
    if (access.status !== 'invited') throw new GoneException('INVITE_NOT_AVAILABLE');
    if (access.inviteExpiresAt < new Date()) throw new GoneException('INVITE_EXPIRED');
    // Bound to the address it was sent to, so a forwarded link does not open someone's client list.
    if (userEmail.trim().toLowerCase() !== access.email) throw new ForbiddenException('INVITE_EMAIL_MISMATCH');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.masterAccess.updateMany({ where: { id: access.id, status: 'invited' }, data: { status: 'active', userId, acceptedAt: new Date() } });
      if (updated.count !== 1) throw new GoneException('INVITE_NOT_AVAILABLE');
      await tx.projectEvent.create({ data: { projectId: access.projectId, actorUserId: userId, type: 'master_joined', details: { accessId: access.id, masterKey: access.masterKey } } });
    });
    return { data: { ok: true } };
  }

  /** The master's own bookings in every place they work, from 12 hours ago for the next 30 days. */
  async myBookings(userId: string) {
    const accesses = await this.prisma.masterAccess.findMany({ where: { userId, status: 'active' }, select: { id: true, projectId: true, masterKey: true, project: { select: { name: true, status: true, publication: { select: { buildVersionId: true } } } } } });
    const now = Date.now();
    const places = await Promise.all(accesses.map(async (access) => {
      const master = (await this.scheduleMasters(access.project.publication?.buildVersionId)).find((item) => item.key === access.masterKey);
      const bookings = await this.prisma.booking.findMany({
        where: { projectId: access.projectId, masterKey: access.masterKey, endsAt: { gte: new Date(now - 12 * 3_600_000) }, startsAt: { lte: new Date(now + 30 * 86_400_000) } },
        orderBy: { startsAt: 'asc' }, take: 300,
        select: { id: true, serviceName: true, minutes: true, price: true, startsAt: true, endsAt: true, timezone: true, clientName: true, clientPhone: true, comment: true, status: true },
      });
      return { accessId: access.id, projectId: access.projectId, placeName: access.project.name, masterName: master?.name ?? null, archived: access.project.status === 'archived', bookings };
    }));
    return { data: { places } };
  }

  /** After the visit the master marks it; cancelling stays with the owner. */
  async markVisit(userId: string, bookingId: string, status: 'done' | 'no_show') {
    if (!uuid.test(bookingId)) throw new NotFoundException('BOOKING_NOT_FOUND');
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, projectId: true, masterKey: true, status: true, startsAt: true } });
    const access = booking ? await this.prisma.masterAccess.findFirst({ where: { userId, status: 'active', projectId: booking.projectId, masterKey: booking.masterKey }, select: { id: true } }) : null;
    if (!booking || !access) throw new NotFoundException('BOOKING_NOT_FOUND');
    if (!['booked', 'done', 'no_show'].includes(booking.status) || booking.startsAt > new Date()) throw new ConflictException('BOOKING_NOT_STARTED');
    await this.prisma.$transaction([
      this.prisma.booking.update({ where: { id: booking.id }, data: { status } }),
      this.prisma.projectEvent.create({ data: { projectId: booking.projectId, actorUserId: userId, type: 'booking_status_changed', details: { bookingId, status, by: 'master' } } }),
    ]);
    return this.myBookings(userId);
  }
}
