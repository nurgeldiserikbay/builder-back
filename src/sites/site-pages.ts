// Small server-rendered pages for published sites: privacy notice, thank-you and error pages.
import type { SiteMeta } from '../journey/artifacts.js';
import { tr } from '../i18n/i18n.js';
import { escapeHtml } from '../journey/site-renderer.js';

const fallbackTheme: SiteMeta['theme'] = { background: '#f7f8f4', text: '#17251f', muted: '#4f5f57', accent: '#255b42', accentText: '#ffffff', font: 'ui-sans-serif, system-ui, sans-serif', radius: '16px' };

export function page(meta: Partial<SiteMeta> | null, title: string, body: string): string {
  const theme = meta?.theme ?? fallbackTheme;
  const lang = meta?.locale ?? 'ru';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:${theme.background};color:${theme.text};font-family:${theme.font};font-size:17px;line-height:1.6}
main{max-width:640px;margin:0 auto;padding:48px 20px}h1{font-size:30px;line-height:1.2;margin:0 0 16px}p,li{color:${theme.muted}}
a.button{display:inline-block;margin-top:16px;background:${theme.accent};color:${theme.accentText};text-decoration:none;font-weight:700;padding:14px 22px;border-radius:${theme.radius}}
a{color:${theme.accent}}</style></head><body><main>${body}</main></body></html>`;
}

export function thanksPage(meta: SiteMeta | null): string {
  return page(meta, tr('Заявка отправлена'), `<h1>${tr('Спасибо! Заявка отправлена')}</h1><p>${tr('{0} свяжется с вами по указанному контакту.', [escapeHtml(meta?.businessName ?? tr('Владелец сайта'))])}</p><a class="button" href="/">${tr('Вернуться на сайт')}</a>`);
}

export function privacyPage(meta: SiteMeta | null, retentionDays: number, remindersByEmail = false): string {
  const name = escapeHtml(meta?.businessName ?? tr('этого сайта'));
  const contacts = meta?.ownerContacts?.length
    ? `<ul>${meta.ownerContacts.map((contact) => `<li>${escapeHtml(tr(contact.label))}: ${escapeHtml(contact.value)}</li>`).join('')}</ul>` : `<p>${tr('Контакты владельца указаны на главной странице сайта.')}</p>`;
  const months = Math.round(retentionDays / 30);
  const booking = meta?.booking
    ? `<p>${tr('Когда вы записываетесь онлайн, сайт «{0}» получает ваше имя, телефон, комментарий и выбранное время. Эти данные нужны, чтобы вас записать и связаться с вами по записи, и не используются для рассылок. Записи хранятся не дольше {1} мес. после визита.', [name, months])}</p>${remindersByEmail ? `<p>${tr('Если при записи вы указали почту, мы отправим на неё одно письмо-напоминание о визите. Адрес хранится только до отправки напоминания (или до отмены записи) и после этого удаляется.')}</p>` : ''}`
    : '';
  const store = meta?.store ? `<p>${tr('Когда вы оформляете заказ, сайт «{0}» получает ваше имя, телефон, адрес доставки, комментарий и состав заказа. Эти данные нужны, чтобы выполнить заказ и связаться с вами по нему, и не используются для рассылок.', [name])}</p>` : '';
  return page(meta, tr('Как используются ваши данные'), `<h1>${tr('Как используются ваши данные')}</h1>
${booking}${store}
<p>${meta?.booking ? tr('Сайт «{0}» получает ваше имя, контакт и сообщение только когда вы сами отправляете форму записи или заявки. Эти данные нужны, чтобы связаться с вами, и не используются для рассылок.', [name]) : tr('Сайт «{0}» получает ваше имя, контакт и сообщение только когда вы сами отправляете форму заявки. Эти данные нужны, чтобы связаться с вами, и не используются для рассылок.', [name])}</p>
<p>${meta?.booking ? tr('Данные получает владелец сайта «{0}», а запись — ещё и мастер, к которому вы записались. Сайт работает на платформе BuildPath, которая хранит заявки по поручению владельца и передаёт их ему в Telegram или по электронной почте.', [name]) : tr('Данные получает владелец сайта «{0}». Сайт работает на платформе BuildPath, которая хранит заявки по поручению владельца и передаёт их ему в Telegram или по электронной почте.', [name])}</p>
<p>${tr('Заявки хранятся не дольше {0} мес., затем удаляются автоматически. Владелец может удалить их раньше.', [months])}</p>
<p>${tr('Чтобы узнать, какие ваши данные хранятся, или попросить удалить их, свяжитесь с владельцем сайта:')}</p>${contacts}
<p>${tr('Сайт не использует cookies и счётчики посещений.')}</p><a class="button" href="/">${tr('Вернуться на сайт')}</a>`);
}

/** Title and text are platform texts and are shown in the site's language. */
export function messagePage(meta: SiteMeta | null, title: string, text: string, back = true): string {
  return page(meta, tr(title), `<h1>${escapeHtml(tr(title))}</h1><p>${escapeHtml(tr(text))}</p>${back ? `<a class="button" href="/">${tr('Вернуться на сайт')}</a>` : ''}`);
}

export interface LeadInput { name: string; contact: string; message: string | null }

/** Validates an urlencoded lead form. Returns null for spam (honeypot), or an error message for the visitor. */
export function parseLeadForm(raw: string): { ok: true; lead: LeadInput } | { ok: false; spam: boolean; error: string } {
  const form = new URLSearchParams(raw);
  if ((form.get('website') ?? '').trim()) return { ok: false, spam: true, error: '' };
  const clean = (value: string | null) => (value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const name = clean(form.get('name'));
  const contact = clean(form.get('contact'));
  const message = clean(form.get('message'));
  if (form.get('consent') !== 'yes') return { ok: false, spam: false, error: tr('Чтобы отправить заявку, отметьте согласие на обработку данных.') };
  if (!name || name.length > 80) return { ok: false, spam: false, error: tr('Укажите имя (до 80 символов).') };
  if (contact.length < 3 || contact.length > 120) return { ok: false, spam: false, error: tr('Укажите телефон или мессенджер, чтобы с вами могли связаться.') };
  if (message.length > 1000) return { ok: false, spam: false, error: tr('Сообщение слишком длинное — до 1000 символов.') };
  return { ok: true, lead: { name, contact, message: message || null } };
}
