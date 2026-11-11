// E-mail reminders for clients who left an address when booking. The address and the sealed cancel link are kept only
// until the reminder is handled, then erased. Runs in the sites process; each booking is claimed (pending → sending)
// before sending, so several processes never send the same reminder twice.
import type { PrismaClient } from '../generated/prisma/client.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { dayLabel, localClock, localDay } from '../journey/schedule.js';
import { openSecret, sealSecret, secretKey } from '../common/secret-box.js';
import { emailConfig, sendEmail } from './email.js';

const HOUR = 3_600_000;

/** A day before; when booked later than that, two hours before — unless the visit is too close for a reminder to help. */
export function reminderTime(startsAt: Date, createdAt: Date): Date | null {
  const dayBefore = new Date(startsAt.getTime() - 24 * HOUR);
  if (dayBefore.getTime() >= createdAt.getTime() + HOUR) return dayBefore;
  const shortly = new Date(startsAt.getTime() - 2 * HOUR);
  return shortly.getTime() >= createdAt.getTime() + HOUR ? shortly : null;
}

/** Fields stored with a new booking so its reminder can be sent; nothing when the client gave no address or mail is off. */
export function reminderFields(email: string | null, token: string, startsAt: Date, now: Date, env = process.env) {
  if (!email || !emailConfig(env)) return {};
  const at = reminderTime(startsAt, now);
  if (!at) return {};
  const key = secretKey(env);
  return { clientEmail: email, reminderAt: at, reminderStatus: 'pending', cancelLinkSealed: key ? sealSecret(token, key) : null };
}

export interface ReminderInput {
  siteName: string; siteUrl: string; serviceName: string; masterName: string; startsAt: Date; timezone: string; minutes: number; price: string | null;
  clientName: string; cancelUrl: string | null; canCancel: boolean; cancelHours: number; contacts: Array<{ label: string; value: string }>;
}

/** The reminder in the current language (the project's language — the client booked on that site). */
export function reminderEmail(input: ReminderInput, now: Date): { subject: string; html: string } {
  const day = localDay(input.startsAt, input.timezone);
  const tomorrow = localDay(new Date(now.getTime() + 24 * HOUR), input.timezone) === day;
  const today = localDay(now, input.timezone) === day;
  const clock = localClock(input.startsAt, input.timezone);
  const when = today ? tr('сегодня в {0}', [clock]) : tomorrow ? tr('завтра в {0}', [clock]) : tr('{0} в {1}', [dayLabel(day), clock]);
  const contacts = input.contacts.map((item) => `<li>${escapeHtml(tr(item.label))}: ${escapeHtml(item.value)}</li>`).join('');
  const cancel = input.canCancel && input.cancelUrl
    ? `<p>${tr('Если планы изменились, отмените запись по ссылке — время освободится для других:')} <a href="${escapeHtml(input.cancelUrl)}">${tr('посмотреть или отменить запись')}</a>.</p>`
    : `<p>${tr('Если планы изменились, предупредите нас, пожалуйста.')}</p>`;
  const site = `<a href="${escapeHtml(input.siteUrl)}">${escapeHtml(input.siteUrl.replace(/^https?:\/\//, ''))}</a>`;
  return {
    subject: tr('Напоминание: {0}, {1}', [input.siteName, when]),
    html: `<div style="font:16px/1.5 system-ui,sans-serif;max-width:520px">
<p>${tr('Здравствуйте, {0}!', [escapeHtml(input.clientName)])}</p>
<p>${tr('Напоминаем о записи в «{0}» {1}.', [escapeHtml(input.siteName), `<strong>${escapeHtml(when)}</strong>`])}</p>
<ul><li>${escapeHtml(input.serviceName)}</li><li>${tr('Мастер: {0}', [escapeHtml(input.masterName)])}</li>${input.price ? `<li>${tr('Цена: {0}', [escapeHtml(input.price)])}</li>` : ''}</ul>
${cancel}${contacts ? `<p>${tr('Контакты:')}</p><ul>${contacts}</ul>` : ''}
<p style="color:#666;font-size:13px">${tr('Вы получили это письмо, потому что указали почту при записи на сайте {0}. Больше писем не будет: адрес удалён после отправки напоминания.', [site])}</p>
</div>`,
  };
}

type SiteMetaLike = { ownerContacts?: Array<{ label: string; value: string }>; booking?: { schedule: { rules: { cancelHours: number } } } } | null;

/** Sends reminders that are due. Returns counts; failures are recorded on the booking, never thrown per booking. */
export async function sendDueReminders(prisma: PrismaClient, siteUrl: (publication: { slug: string; customDomain: string | null; domainStatus: string | null }) => string, now = new Date(), env = process.env) {
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const config = emailConfig(env);
  const key = secretKey(env);
  // Bookings that were cancelled or whose time passed no longer need a reminder: erase the address.
  const stale = await prisma.booking.updateMany({
    where: { reminderStatus: 'pending', OR: [{ status: { not: 'booked' } }, { startsAt: { lte: now } }] },
    data: { reminderStatus: 'skipped', clientEmail: null, cancelLinkSealed: null },
  });
  counts.skipped += stale.count;
  // A process that stopped mid-send leaves «sending»; after an hour it is recorded as failed rather than risk a second e-mail.
  const stuck = await prisma.booking.updateMany({ where: { reminderStatus: 'sending', reminderAt: { lt: new Date(now.getTime() - HOUR) } }, data: { reminderStatus: 'failed', clientEmail: null, cancelLinkSealed: null } });
  counts.failed += stuck.count;
  const due = await prisma.booking.findMany({
    where: { reminderStatus: 'pending', status: 'booked', reminderAt: { lte: now }, startsAt: { gt: now } },
    orderBy: { reminderAt: 'asc' }, take: 50,
    select: {
      id: true, clientEmail: true, clientName: true, serviceName: true, masterName: true, startsAt: true, timezone: true, minutes: true, price: true, cancelLinkSealed: true,
      project: { select: { name: true, locale: true } },
      publication: { select: { slug: true, customDomain: true, domainStatus: true, status: true, buildVersionId: true } },
    },
  });
  for (const booking of due) {
    const claimed = await prisma.booking.updateMany({ where: { id: booking.id, reminderStatus: 'pending' }, data: { reminderStatus: 'sending' } });
    if (!claimed.count) continue;
    let status: 'sent' | 'failed' | 'skipped' = 'skipped';
    if (config && booking.clientEmail && booking.publication.status === 'live') {
      const version = await prisma.stageArtifactVersion.findUnique({ where: { id: booking.publication.buildVersionId }, select: { content: true } });
      const meta = (version?.content as { meta?: SiteMetaLike } | null)?.meta ?? null;
      const base = siteUrl(booking.publication);
      const token = key && booking.cancelLinkSealed ? openSecret(booking.cancelLinkSealed, key) : null;
      const cancelHours = meta?.booking?.schedule.rules.cancelHours ?? 0;
      const mail = runWithLocale(contentLocale(booking.project.locale), () => reminderEmail({
        siteName: booking.project.name, siteUrl: base, serviceName: booking.serviceName, masterName: booking.masterName, startsAt: booking.startsAt, timezone: booking.timezone,
        minutes: booking.minutes, price: booking.price, clientName: booking.clientName, cancelUrl: token ? `${base}/book/b/${token}` : null,
        canCancel: booking.startsAt.getTime() - now.getTime() >= cancelHours * HOUR, cancelHours, contacts: (meta?.ownerContacts ?? []).slice(0, 4),
      }, now));
      status = (await sendEmail(config, booking.clientEmail, mail.subject, mail.html)) ? 'sent' : 'failed';
    }
    await prisma.booking.update({ where: { id: booking.id }, data: { reminderStatus: status, clientEmail: null, cancelLinkSealed: null } });
    counts[status] += 1;
  }
  return counts;
}
