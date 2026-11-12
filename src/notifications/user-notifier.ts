// One place to tell a platform user about something: Telegram when linked, and e-mail when asked for.
import type { PrismaClient } from '../generated/prisma/client.js';
import { contentLocale, inLocale, runWithLocale, tr, type Message } from '../i18n/i18n.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig } from './telegram.js';

export interface UserNotice {
  text: Message;
  /** Send an e-mail too, with this subject. Without it, Telegram only. */
  emailSubject?: Message;
  /** App path for the e-mail button, e.g. /account/disputes. */
  link?: { path: string; label: Message };
}

/** In the user's language. Never throws; accounts being deleted get nothing. */
export async function notifyUser(prisma: Pick<PrismaClient, 'user'>, userId: string | null | undefined, notice: UserNotice): Promise<void> {
  if (!userId) return;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, locale: true, deletionRequestedAt: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } });
    if (!user || user.deletionRequestedAt) return;
    const telegram = telegramConfig();
    const chatId = user.externalIdentities[0]?.chatId;
    if (telegram && chatId) await sendTelegramMessage(telegram, chatId, inLocale(user.locale, notice.text)).catch(() => undefined);
    const mail = notice.emailSubject ? emailConfig() : null;
    if (!mail) return;
    await runWithLocale(contentLocale(user.locale), async () => {
      const appUrl = process.env.PUBLIC_APP_URL;
      const body = inLocale(user.locale, notice.text);
      const link = appUrl && notice.link ? `<p><a href="${escapeHtml(new URL(notice.link.path, appUrl).toString())}">${escapeHtml(inLocale(user.locale, notice.link.label))}</a></p>` : '';
      await sendEmail(mail, user.email, inLocale(user.locale, notice.emailSubject!), `<p style="font:15px/1.5 system-ui,sans-serif">${escapeHtml(body)}</p>${link}`).catch(() => undefined);
    });
  } catch {
    // A failed notice must never undo the action it reports.
  }
}
