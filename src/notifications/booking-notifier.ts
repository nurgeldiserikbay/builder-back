import type { PrismaClient } from '../generated/prisma/client.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { dayLabel, localClock, localDay } from '../journey/schedule.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig } from './telegram.js';
import type { ChannelStatus } from './lead-notifier.js';

export interface BookingForMessage {
  kind: 'created' | 'cancelled_by_client';
  siteName: string; projectId: string; serviceName: string; masterName: string; startsAt: Date; timezone: string;
  clientName: string; clientPhone: string; comment: string | null;
}

export function bookingText(booking: BookingForMessage, appUrl: string | undefined): string {
  const when = `${dayLabel(localDay(booking.startsAt, booking.timezone))}, ${localClock(booking.startsAt, booking.timezone)}`;
  return [
    booking.kind === 'created' ? `Новая запись с сайта «${booking.siteName}»` : `Клиент отменил запись на сайте «${booking.siteName}»`,
    `${booking.serviceName} — ${when}`,
    `Мастер: ${booking.masterName}`,
    `Клиент: ${booking.clientName}, ${booking.clientPhone}`,
    booking.comment ? `Комментарий: ${booking.comment}` : null,
    appUrl ? `Все записи: ${new URL(`/projects/${booking.projectId}/bookings`, appUrl).toString()}` : null,
  ].filter(Boolean).join('\n');
}

/** Tells the project owner about a new or cancelled booking, using the site's notification settings. Never throws. */
export async function notifyBooking(prisma: PrismaClient, bookingId: string, kind: BookingForMessage['kind']): Promise<ChannelStatus> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, projectId: true, serviceName: true, masterName: true, startsAt: true, timezone: true, clientName: true, clientPhone: true, comment: true,
        publication: { select: { notifyTelegram: true, notifyEmail: true } },
        project: { select: { name: true, owner: { select: { email: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } } } },
      },
    });
    if (!booking) return 'failed';
    const text = bookingText({ kind, siteName: booking.project.name, ...booking }, process.env.PUBLIC_APP_URL);
    let telegram: ChannelStatus = 'off';
    if (booking.publication.notifyTelegram) {
      const config = telegramConfig();
      const chatId = booking.project.owner.externalIdentities[0]?.chatId;
      telegram = !config ? 'not_configured' : !chatId ? 'not_linked' : (await sendTelegramMessage(config, chatId, text)) ? 'sent' : 'failed';
    }
    if (booking.publication.notifyEmail) {
      const config = emailConfig();
      if (config) await sendEmail(config, booking.project.owner.email, `${kind === 'created' ? 'Новая запись' : 'Отмена записи'}: ${booking.project.name}`, `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`);
    }
    if (kind === 'created') await prisma.booking.update({ where: { id: booking.id }, data: { telegramStatus: telegram } });
    return telegram;
  } catch {
    return 'failed';
  }
}
