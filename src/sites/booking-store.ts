// Booking writes for published sites. A transaction-scoped advisory lock per publication serialises bookings,
// and the free time is recomputed inside it, so two clients can never get the same master at overlapping times.
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { slotsFor, localDay, type BookingConfig, type Busy } from '../journey/schedule.js';
import type { BookingForm } from './booking-pages.js';
import { reminderFields } from '../notifications/booking-reminders.js';

export const ACTIVE_STATUSES = ['booked', 'done', 'no_show'];
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

type Db = Pick<PrismaClient, 'booking'>;

export async function busyBetween(db: Db, publicationId: string, from: Date, to: Date): Promise<Busy[]> {
  return db.booking.findMany({
    where: { publicationId, status: { in: ACTIVE_STATUSES }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { masterKey: true, startsAt: true, endsAt: true },
  });
}

export type CreateResult = { ok: true; id: string; token: string } | { ok: false; reason: 'unknown_service' | 'taken' };

export async function createBooking(prisma: PrismaClient, site: { publicationId: string; projectId: string }, config: BookingConfig, form: BookingForm, ipHash: string, now = new Date()): Promise<CreateResult> {
  const service = config.schedule.services[form.service];
  if (!service) return { ok: false, reason: 'unknown_service' };
  const day = localDay(form.start, config.schedule.timezone);
  const token = randomBytes(24).toString('base64url');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${site.publicationId}))`;
    const from = new Date(form.start.getTime() - 86_400_000);
    const busy = await busyBetween(tx, site.publicationId, from, new Date(form.start.getTime() + 2 * 86_400_000));
    const slot = slotsFor(config.schedule, service.name, form.master === 'any' ? null : form.master, day, busy, now)
      .find((item) => item.startsAt.getTime() === form.start.getTime());
    if (!slot) return { ok: false as const, reason: 'taken' as const };
    // «Any master»: the one with the fewest bookings that day, so work is shared.
    const load = (key: string) => busy.filter((item) => item.masterKey === key && localDay(item.startsAt, config.schedule.timezone) === day).length;
    const masterKey = [...slot.masterKeys].sort((a, b) => load(a) - load(b))[0]!;
    const master = config.schedule.masters.find((item) => item.key === masterKey)!;
    const created = await tx.booking.create({
      data: {
        projectId: site.projectId, publicationId: site.publicationId, serviceName: service.name, minutes: service.minutes, price: config.prices[service.name] ?? null,
        masterKey, masterName: master.name, startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: config.schedule.timezone,
        clientName: form.name, clientPhone: form.phone, comment: form.comment, tokenHash: tokenHash(token), consentAt: now, ipHash,
        ...reminderFields(form.email, token, slot.startsAt, now),
      },
      select: { id: true },
    });
    return { ok: true as const, id: created.id, token };
  });
}

export function canClientCancel(booking: { status: string; startsAt: Date }, cancelHours: number, now = new Date()): boolean {
  return booking.status === 'booked' && booking.startsAt.getTime() - now.getTime() >= cancelHours * 3_600_000;
}
