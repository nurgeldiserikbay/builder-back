import type { PrismaClient } from '../generated/prisma/client.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { dayLabel, localClock, localDay } from '../journey/schedule.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig } from './telegram.js';
import type { ChannelStatus } from './lead-notifier.js';

export interface BookingForMessage {
  kind: 'created' | 'cancelled_by_client';
  siteName: string; projectId: string; serviceName: string; masterName: string; startsAt: Date; timezone: string;
  clientName: string; clientPhone: string; comment: string | null;
}

/** Text for the owner (link to all bookings) or the master (link to their own page), in the current language. */
export function bookingText(booking: BookingForMessage, appUrl: string | undefined, reader: 'owner' | 'master' = 'owner'): string {
  const when = `${dayLabel(localDay(booking.startsAt, booking.timezone))}, ${localClock(booking.startsAt, booking.timezone)}`;
  const link = !appUrl ? null
    : reader === 'owner' ? tr('Все записи: {0}', [new URL(`/projects/${booking.projectId}/bookings`, appUrl).toString()])
      : tr('Ваши записи: {0}', [new URL('/master', appUrl).toString()]);
  return [
    booking.kind === 'created' ? tr('Новая запись с сайта «{0}»', [booking.siteName]) : tr('Клиент отменил запись на сайте «{0}»', [booking.siteName]),
    `${booking.serviceName} — ${when}`,
    tr('Мастер: {0}', [booking.masterName]),
    tr('Клиент: {0}', [`${booking.clientName}, ${booking.clientPhone}`]),
    booking.comment ? tr('Комментарий: {0}', [booking.comment]) : null,
    link,
  ].filter(Boolean).join('\n');
}

/** Tells the project owner about a new or cancelled booking, using the site's notification settings. Never throws. */
export async function notifyBooking(prisma: PrismaClient, bookingId: string, kind: BookingForMessage['kind']): Promise<ChannelStatus> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, projectId: true, masterKey: true, serviceName: true, masterName: true, startsAt: true, timezone: true, clientName: true, clientPhone: true, comment: true,
        publication: { select: { notifyTelegram: true, notifyEmail: true } },
        project: { select: { name: true, owner: { select: { email: true, locale: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } } } },
      },
    });
    if (!booking) return 'failed';
    const message: BookingForMessage = { kind, siteName: booking.project.name, ...booking };
    const ownerLocale = contentLocale(booking.project.owner.locale);
    const text = runWithLocale(ownerLocale, () => bookingText(message, process.env.PUBLIC_APP_URL));
    let telegram: ChannelStatus = 'off';
    if (booking.publication.notifyTelegram) {
      const config = telegramConfig();
      const chatId = booking.project.owner.externalIdentities[0]?.chatId;
      telegram = !config ? 'not_configured' : !chatId ? 'not_linked' : (await sendTelegramMessage(config, chatId, text)) ? 'sent' : 'failed';
    }
    if (booking.publication.notifyEmail) {
      const config = emailConfig();
      if (config) await sendEmail(config, booking.project.owner.email, runWithLocale(ownerLocale, () => tr(kind === 'created' ? 'Новая запись: {0}' : 'Отмена записи: {0}', [booking.project.name])), `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`);
    }
    await notifyMaster(prisma, booking, message).catch(() => undefined);
    if (kind === 'created') await prisma.booking.update({ where: { id: booking.id }, data: { telegramStatus: telegram } });
    return telegram;
  } catch {
    return 'failed';
  }
}

/** The master the client booked with also hears about it — in their account language, in Telegram if they linked it, otherwise by e-mail. */
async function notifyMaster(prisma: PrismaClient, booking: { projectId: string; masterKey: string; project: { name: string } }, message: BookingForMessage) {
  const access = await prisma.masterAccess.findFirst({ where: { projectId: booking.projectId, masterKey: booking.masterKey, status: 'active' }, select: { userId: true } });
  if (!access?.userId) return;
  const user = await prisma.user.findUnique({ where: { id: access.userId }, select: { email: true, locale: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } });
  if (!user) return;
  await runWithLocale(contentLocale(user.locale), async () => {
    const masterText = bookingText(message, process.env.PUBLIC_APP_URL, 'master');
    const chatId = user.externalIdentities[0]?.chatId;
    const telegram = telegramConfig();
    if (telegram && chatId && (await sendTelegramMessage(telegram, chatId, masterText))) return;
    const mail = emailConfig();
    if (mail) await sendEmail(mail, user.email, tr(message.kind === 'created' ? 'Новая запись к вам: {0}' : 'Отмена записи: {0}', [booking.project.name]), `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(masterText)}</pre>`);
  });
}
