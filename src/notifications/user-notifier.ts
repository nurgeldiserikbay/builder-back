// One place to tell a platform user about something: Telegram when linked, and e-mail when asked for.
import type { PrismaClient } from '../generated/prisma/client.js';
import { contentLocale, inLocale, runWithLocale, tr, type Message } from '../i18n/i18n.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig, type InlineKeyboard } from './telegram.js';
import { channelsFor, prefsOf, type NotifyCategory } from '../account/notification-prefs.js';

export interface UserNotice {
  text: Message;
  /** Which of the person's notification settings apply (account/notification-prefs.ts). Default: stage work. */
  category?: NotifyCategory;
  /** A short follow-up that is not worth an e-mail even when e-mail is on (a reminder in a running thread). */
  telegramOnly?: boolean;
  /** E-mail subject. Without it an e-mail (when the person asked for e-mail in this category) gets a general subject and a link to «Входящие». */
  emailSubject?: Message;
  /** App path for the e-mail button, e.g. /account/disputes. */
  link?: { path: string; label: Message };
  /** Buttons under the Telegram message, built in the user's language. */
  telegramKeyboard?: () => InlineKeyboard;
}

/** In the user's language. Never throws; accounts being deleted get nothing. */
export async function notifyUser(prisma: Pick<PrismaClient, 'user'>, userId: string | null | undefined, notice: UserNotice): Promise<void> {
  if (!userId) return;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, locale: true, deletionRequestedAt: true, notificationPrefs: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } });
    if (!user || user.deletionRequestedAt) return;
    const channels = channelsFor(prefsOf(user.notificationPrefs), notice.category ?? 'stages');
    const telegram = channels.telegram ? telegramConfig() : null;
    const chatId = user.externalIdentities[0]?.chatId;
    if (telegram && chatId) await sendTelegramMessage(telegram, chatId, inLocale(user.locale, notice.text), fetch, notice.telegramKeyboard ? runWithLocale(contentLocale(user.locale), notice.telegramKeyboard) : undefined).catch(() => undefined);
    const mail = channels.email && !notice.telegramOnly ? emailConfig() : null;
    if (!mail) return;
    await runWithLocale(contentLocale(user.locale), async () => {
      const appUrl = process.env.PUBLIC_APP_URL;
      const body = inLocale(user.locale, notice.text);
      const target = notice.link ?? { path: '/inbox', label: () => tr('Открыть входящие') };
      const link = appUrl ? `<p><a href="${escapeHtml(new URL(target.path, appUrl).toString())}">${escapeHtml(inLocale(user.locale, target.label))}</a></p>` : '';
      const subject = notice.emailSubject ? inLocale(user.locale, notice.emailSubject) : tr('BuildPath: новое в ваших проектах');
      const settings = appUrl ? `<p style="font:12px/1.5 system-ui,sans-serif;color:#6b7280"><a href="${escapeHtml(new URL('/account/notifications', appUrl).toString())}" style="color:#6b7280">${escapeHtml(tr('Настроить уведомления'))}</a></p>` : '';
      await sendEmail(mail, user.email, subject, `<p style="font:15px/1.5 system-ui,sans-serif;white-space:pre-line">${escapeHtml(body)}</p>${link}${settings}`).catch(() => undefined);
    });
  } catch {
    // A failed notice must never undo the action it reports.
  }
}
