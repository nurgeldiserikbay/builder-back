// Script-free booking pages of a published site: service → master → day and time → contacts → «Ваша запись».
import type { SiteMeta } from '../journey/artifacts.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { dayLabel, doable, localClock, localDay, type BookingConfig, type Slot } from '../journey/schedule.js';
import { page } from './site-pages.js';

export const BOOKING_FORM_PATH = '/__forms/booking';
export const BOOKING_CANCEL_PATH = '/__forms/booking-cancel';

const style = `<style>.steps{color:inherit;opacity:.75;font-size:14px;margin:0 0 6px}.choices{list-style:none;padding:0;margin:16px 0;display:grid;gap:10px}
.choices a,.choices span.off{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;border:1px solid rgba(0,0,0,.15);border-radius:12px;text-decoration:none;font-weight:700;min-height:48px;align-items:center}
.choices a[aria-current="true"]{outline:3px solid currentColor}.choices small{font-weight:400;opacity:.8}.times{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;list-style:none;padding:0;margin:12px 0}
.times a{display:block;text-align:center;padding:12px 0;border:1px solid rgba(0,0,0,.2);border-radius:10px;text-decoration:none;font-weight:700}
form{display:grid;gap:14px;margin:18px 0}label{display:grid;gap:6px;font-weight:700;font-size:15px}input,textarea{font:inherit;font-size:16px;padding:12px;border:1px solid rgba(0,0,0,.25);border-radius:10px;background:#fff;color:#111}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px}.consent input{width:22px;height:22px;flex:none;margin-top:2px}.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{border:0;cursor:pointer;font:inherit;font-weight:700;padding:15px 22px;border-radius:12px;min-height:48px}.summary{border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:14px 16px;margin:12px 0}.summary p{margin:4px 0}
.back{display:inline-block;margin-top:8px}</style>`;

function shell(meta: SiteMeta, title: string, body: string): string {
  const button = `<style>button{background:${meta.theme.accent};color:${meta.theme.accentText}}</style>`;
  return page(meta, title, `${style}${button}${body}`);
}

function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return [hours ? `${hours} ч` : '', minutes % 60 ? `${minutes % 60} мин` : ''].filter(Boolean).join(' ');
}

export interface BookingQuery { service: number | null; master: string | null; day: string | null; start: Date | null }

export function parseQuery(url: URL): BookingQuery {
  const service = /^\d{1,2}$/.test(url.searchParams.get('s') ?? '') ? Number(url.searchParams.get('s')) : null;
  const master = /^(any|[a-z0-9]{2,12})$/.test(url.searchParams.get('m') ?? '') ? url.searchParams.get('m') : null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('d') ?? '') ? url.searchParams.get('d') : null;
  const raw = url.searchParams.get('t') ?? '';
  const start = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(raw) ? new Date(raw) : null;
  return { service, master, day, start: start && !Number.isNaN(start.getTime()) ? start : null };
}

const link = (query: Record<string, string | number>) => `/book?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()}`;

/** Masters who do a service; «any» is offered when there are several. */
export function mastersFor(config: BookingConfig, serviceIndex: number) {
  const service = config.schedule.services[serviceIndex];
  return service ? config.schedule.masters.filter((master) => doable(config.schedule, master).includes(service)) : [];
}

export function servicesPage(meta: SiteMeta, config: BookingConfig): string {
  const items = config.schedule.services.map((service, index) => ({ service, index })).filter(({ index }) => mastersFor(config, index).length > 0);
  return shell(meta, 'Онлайн-запись', `<p class="steps">Шаг 1 из 3</p><h1>Выберите услугу</h1><ul class="choices">${items.map(({ service, index }) =>
    `<li><a href="${link({ s: index })}">${escapeHtml(service.name)}<small>${escapeHtml(minutesText(service.minutes))}${config.prices[service.name] ? ` · ${escapeHtml(config.prices[service.name]!)}` : ''}</small></a></li>`).join('')}</ul><a class="back" href="/">← На сайт</a>`);
}

export function mastersPage(meta: SiteMeta, config: BookingConfig, serviceIndex: number): string {
  const service = config.schedule.services[serviceIndex]!;
  const masters = mastersFor(config, serviceIndex);
  return shell(meta, 'Выберите мастера', `<p class="steps">Шаг 2 из 3 · ${escapeHtml(service.name)}</p><h1>К кому записаться?</h1><ul class="choices">
<li><a href="${link({ s: serviceIndex, m: 'any' })}">Любой свободный мастер<small>больше свободного времени</small></a></li>
${masters.map((master) => `<li><a href="${link({ s: serviceIndex, m: master.key })}">${escapeHtml(master.name)}</a></li>`).join('')}</ul><a class="back" href="/book">← Другая услуга</a>`);
}

export function timesPage(meta: SiteMeta, config: BookingConfig, query: { service: number; master: string }, days: Array<{ day: string; free: number }>, selected: string | null, slots: Slot[]): string {
  const service = config.schedule.services[query.service]!;
  const masterName = query.master === 'any' ? 'любой мастер' : config.schedule.masters.find((master) => master.key === query.master)?.name ?? '';
  const many = mastersFor(config, query.service).length > 1;
  const back = many ? link({ s: query.service }) : '/book';
  if (days.length === 0) {
    return shell(meta, 'Нет свободного времени', `<p class="steps">${escapeHtml(service.name)} · ${escapeHtml(masterName)}</p><h1>Свободного времени пока нет</h1><p>В ближайшие ${config.schedule.rules.horizonDays} дн. всё занято. Попробуйте другого мастера или свяжитесь с нами по контактам на сайте.</p><a class="back" href="${back}">← Назад</a>`);
  }
  const day = selected && days.some((item) => item.day === selected) ? selected : days[0]!.day;
  const timeLinks = slots.map((slot) => `<li><a href="${link({ s: query.service, m: query.master, t: slot.startsAt.toISOString() })}">${localClock(slot.startsAt, config.schedule.timezone)}</a></li>`).join('');
  return shell(meta, 'Выберите время', `<p class="steps">Шаг 3 из 3 · ${escapeHtml(service.name)} · ${escapeHtml(masterName)}</p><h1>Когда вам удобно?</h1>
<ul class="choices">${days.slice(0, 14).map((item) => `<li><a href="${link({ s: query.service, m: query.master, d: item.day })}"${item.day === day ? ' aria-current="true"' : ''}>${escapeHtml(dayLabel(item.day))}<small>свободно: ${item.free}</small></a></li>`).join('')}</ul>
<h2 id="times">${escapeHtml(dayLabel(day))}</h2><ul class="times">${timeLinks}</ul><a class="back" href="${back}">← Назад</a>`);
}

export function confirmPage(meta: SiteMeta, config: BookingConfig, query: { service: number; master: string; start: Date }, error: string | null = null, values: Partial<Record<'name' | 'phone' | 'comment', string>> = {}): string {
  const service = config.schedule.services[query.service]!;
  const masterName = query.master === 'any' ? 'любой свободный мастер' : config.schedule.masters.find((master) => master.key === query.master)?.name ?? '';
  const tz = config.schedule.timezone;
  return shell(meta, 'Подтвердите запись', `<h1>Почти готово</h1><div class="summary"><p><strong>${escapeHtml(service.name)}</strong></p>
<p>${escapeHtml(dayLabel(localDay(query.start, tz)))}, ${localClock(query.start, tz)} · ${escapeHtml(minutesText(service.minutes))}</p><p>Мастер: ${escapeHtml(masterName)}</p>${config.prices[service.name] ? `<p>Цена: ${escapeHtml(config.prices[service.name]!)}</p>` : ''}</div>
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ''}
<form method="post" action="${BOOKING_FORM_PATH}"><input type="hidden" name="s" value="${query.service}"><input type="hidden" name="m" value="${escapeHtml(query.master)}"><input type="hidden" name="t" value="${query.start.toISOString()}">
<label>Ваше имя<input name="name" required maxlength="80" autocomplete="name" value="${escapeHtml(values.name ?? '')}"></label>
<label>Телефон<input name="phone" required maxlength="30" inputmode="tel" autocomplete="tel" placeholder="+7 700 000 00 00" value="${escapeHtml(values.phone ?? '')}"></label>
<label>Комментарий (необязательно)<textarea name="comment" maxlength="300">${escapeHtml(values.comment ?? '')}</textarea></label>
<div class="hp" aria-hidden="true"><label>Сайт<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>Согласен(на) на обработку моих данных для записи. <a href="/privacy">Как используются данные</a></span></label>
<button type="submit">Записаться</button></form><a class="back" href="${link({ s: query.service, m: query.master, d: localDay(query.start, tz) })}">← Другое время</a>`);
}

export interface BookingView { serviceName: string; masterName: string; startsAt: Date; minutes: number; price: string | null; timezone: string; status: string; clientName: string }

export function bookingPage(meta: SiteMeta, booking: BookingView, token: string, canCancel: boolean, cancelHours: number, justCreated: boolean): string {
  const tz = booking.timezone;
  const when = `${dayLabel(localDay(booking.startsAt, tz))}, ${localClock(booking.startsAt, tz)}`;
  const status = booking.status === 'booked' ? '' : booking.status.startsWith('cancelled') ? '<p role="status"><strong>Запись отменена.</strong></p>' : '<p role="status"><strong>Визит прошёл.</strong></p>';
  const contacts = meta.ownerContacts.map((contact) => `<p>${escapeHtml(contact.label)}: ${escapeHtml(contact.value)}</p>`).join('');
  const cancel = booking.status !== 'booked' ? ''
    : canCancel ? `<form method="post" action="${BOOKING_CANCEL_PATH}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Отменить запись</button></form><p>Отменить можно не позже чем за ${cancelHours} ч до начала.</p>`
      : `<p>Отменить онлайн уже нельзя — до начала меньше ${cancelHours} ч. Свяжитесь с нами:</p>${contacts}`;
  return shell(meta, 'Ваша запись', `<h1>${justCreated ? 'Вы записаны!' : 'Ваша запись'}</h1>${status}<div class="summary"><p><strong>${escapeHtml(booking.serviceName)}</strong></p><p>${escapeHtml(when)} · ${escapeHtml(minutesText(booking.minutes))}</p><p>Мастер: ${escapeHtml(booking.masterName)}</p>${booking.price ? `<p>Цена: ${escapeHtml(booking.price)}</p>` : ''}</div>
${justCreated && booking.status === 'booked' ? '<p><strong>Сохраните эту страницу в закладки</strong> — по ней можно посмотреть или отменить запись.</p>' : ''}${cancel}<a class="back" href="/">← На сайт</a>`);
}

export interface BookingForm { service: number; master: string; start: Date; name: string; phone: string; comment: string | null }

/** Validates the urlencoded booking form; spam (honeypot) is reported separately so the bot sees a normal answer. */
export function parseBookingForm(raw: string): { ok: true; form: BookingForm } | { ok: false; spam: boolean; error: string; values: Partial<Record<'name' | 'phone' | 'comment', string>>; query: BookingQuery } {
  const form = new URLSearchParams(raw);
  const clean = (value: string | null) => (value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  const query = parseQuery(new URL(`http://x/book?${new URLSearchParams({ s: form.get('s') ?? '', m: form.get('m') ?? '', t: form.get('t') ?? '' })}`));
  const values = { name: clean(form.get('name')), phone: clean(form.get('phone')), comment: clean(form.get('comment')) };
  const fail = (error: string) => ({ ok: false as const, spam: false, error, values, query });
  if (clean(form.get('website'))) return { ok: false, spam: true, error: '', values, query };
  if (query.service === null || !query.master || !query.start) return fail('Выберите услугу и время заново.');
  if (form.get('consent') !== 'yes') return fail('Чтобы записаться, отметьте согласие на обработку данных.');
  if (!values.name || values.name.length > 80) return fail('Укажите имя (до 80 символов).');
  const digits = values.phone.replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(digits)) return fail('Укажите телефон полностью, например +7 700 000 00 00.');
  if (values.comment.length > 300) return fail('Комментарий слишком длинный — до 300 символов.');
  return { ok: true, form: { service: query.service, master: query.master, start: query.start, name: values.name, phone: values.phone, comment: values.comment || null } };
}
