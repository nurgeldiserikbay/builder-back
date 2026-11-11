// Small server-rendered pages for published sites: privacy notice, thank-you and error pages.
import type { SiteMeta } from '../journey/artifacts.js';
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
  return page(meta, 'Заявка отправлена', `<h1>Спасибо! Заявка отправлена</h1><p>${escapeHtml(meta?.businessName ?? 'Владелец сайта')} свяжется с вами по указанному контакту.</p><a class="button" href="/">Вернуться на сайт</a>`);
}

export function privacyPage(meta: SiteMeta | null, retentionDays: number, remindersByEmail = false): string {
  const name = escapeHtml(meta?.businessName ?? 'этого сайта');
  const contacts = meta?.ownerContacts?.length
    ? `<ul>${meta.ownerContacts.map((contact) => `<li>${escapeHtml(contact.label)}: ${escapeHtml(contact.value)}</li>`).join('')}</ul>` : '<p>Контакты владельца указаны на главной странице сайта.</p>';
  const months = Math.round(retentionDays / 30);
  return page(meta, 'Как используются ваши данные', `<h1>Как используются ваши данные</h1>
${meta?.booking ? `<p>Когда вы записываетесь онлайн, сайт «${name}» получает ваше имя, телефон, комментарий и выбранное время. Эти данные нужны, чтобы вас записать и связаться с вами по записи, и не используются для рассылок. Записи хранятся не дольше ${Math.round(retentionDays / 30)} мес. после визита.</p>${remindersByEmail ? '<p>Если при записи вы указали почту, мы отправим на неё одно письмо-напоминание о визите. Адрес хранится только до отправки напоминания (или до отмены записи) и после этого удаляется.</p>' : ''}` : ''}
<p>Сайт «${name}» получает ваше имя, контакт и сообщение только когда вы сами отправляете форму${meta?.booking ? ' записи или заявки' : ' заявки'}. Эти данные нужны, чтобы связаться с вами, и не используются для рассылок.</p>
<p>Данные получает владелец сайта «${name}»${meta?.booking ? ', а запись — ещё и мастер, к которому вы записались' : ''}. Сайт работает на платформе BuildPath, которая хранит заявки по поручению владельца и передаёт их ему в Telegram или по электронной почте.</p>
<p>Заявки хранятся не дольше ${months} мес., затем удаляются автоматически. Владелец может удалить их раньше.</p>
<p>Чтобы узнать, какие ваши данные хранятся, или попросить удалить их, свяжитесь с владельцем сайта:</p>${contacts}
<p>Сайт не использует cookies и счётчики посещений.</p><a class="button" href="/">Вернуться на сайт</a>`);
}

export function messagePage(meta: SiteMeta | null, title: string, text: string, back = true): string {
  return page(meta, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${back ? '<a class="button" href="/">Вернуться на сайт</a>' : ''}`);
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
  if (form.get('consent') !== 'yes') return { ok: false, spam: false, error: 'Чтобы отправить заявку, отметьте согласие на обработку данных.' };
  if (!name || name.length > 80) return { ok: false, spam: false, error: 'Укажите имя (до 80 символов).' };
  if (contact.length < 3 || contact.length > 120) return { ok: false, spam: false, error: 'Укажите телефон или мессенджер, чтобы с вами могли связаться.' };
  if (message.length > 1000) return { ok: false, spam: false, error: 'Сообщение слишком длинное — до 1000 символов.' };
  return { ok: true, lead: { name, contact, message: message || null } };
}
