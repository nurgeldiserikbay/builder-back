// Online booking app that the owner can run on their own server. Bundled by scripts/build-export.mjs into one file without
// dependencies (Node.js 22+), from the same schedule and booking-page modules the BuildPath sites server uses.
// Storage is one JSON file written atomically; all writes go through one queue, so one process never double-books.
// Run a single instance only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { SiteMeta } from '../journey/artifacts.js';
import { escapeHtml, pageCsp } from '../journey/site-renderer.js';
import { dayLabel, localClock, localDay, openDays, slotsFor, type BookingConfig, type Busy } from '../journey/schedule.js';
import { BOOKING_CANCEL_PATH, BOOKING_FORM_PATH, bookingPage, confirmPage, mastersFor, mastersPage, parseBookingForm, parseQuery, servicesPage, timesPage } from '../sites/booking-pages.js';
import { messagePage, page } from '../sites/site-pages.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';

export interface ExportConfig { version: string; meta: SiteMeta; booking: BookingConfig }
export interface StoredBooking {
  id: string; serviceName: string; minutes: number; price: string | null; masterKey: string; masterName: string;
  startsAt: string; endsAt: string; clientName: string; clientPhone: string; comment: string | null;
  status: 'booked' | 'cancelled_by_client' | 'cancelled_by_owner' | 'done' | 'no_show'; tokenHash: string; createdAt: string;
}

const ACTIVE = new Set(['booked', 'done', 'no_show']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function createBookingApp(options: { config: ExportConfig; html: string; dataDir: string; adminPassword: string | null; telegram: { token: string; chatId: string } | null; retentionDays?: number; now?: () => Date }) {
  const { config, html } = options;
  const meta = config.meta;
  const booking = config.booking;
  const tz = booking.schedule.timezone;
  const now = options.now ?? (() => new Date());
  const file = path.join(options.dataDir, 'bookings.json');
  let rows: StoredBooking[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const recent = new Map<string, number[]>();

  async function load(): Promise<StoredBooking[]> {
    if (rows) return rows;
    try { rows = JSON.parse(await readFile(file, 'utf8')) as StoredBooking[]; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      rows = [];
    }
    return rows;
  }
  async function save(): Promise<void> {
    await mkdir(options.dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(rows, null, 1));
    await rename(temp, file);
  }
  /** Serialises every read-modify-write. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }
  const busy = (list: StoredBooking[]): Busy[] => list.filter((item) => ACTIVE.has(item.status)).map((item) => ({ masterKey: item.masterKey, startsAt: new Date(item.startsAt), endsAt: new Date(item.endsAt) }));

  async function notify(text: string) {
    if (!options.telegram) return;
    await fetch(`https://api.telegram.org/bot${options.telegram.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: options.telegram.chatId, text }),
    }).catch(() => undefined);
  }
  const describe = (item: StoredBooking) => `${item.serviceName} — ${dayLabel(localDay(new Date(item.startsAt), tz))}, ${localClock(new Date(item.startsAt), tz)}\n${tr('Мастер: {0}', [item.masterName])}\n${tr('Клиент: {0}', [`${item.clientName}, ${item.clientPhone}`])}${item.comment ? `\n${tr('Комментарий: {0}', [item.comment])}` : ''}`;

  function send(response: ServerResponse, status: number, body: string, type = 'text/html', extra: Record<string, string> = {}) {
    response.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': `${pageCsp(true)}; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...extra,
    });
    response.end(body);
  }
  async function body(request: IncomingMessage, limit: number): Promise<string | null> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > limit) return null; chunks.push(chunk as Buffer); }
    return Buffer.concat(chunks).toString('utf8');
  }
  function sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return !origin || origin === 'null' || new URL(origin).host === request.headers.host;
  }
  function ip(request: IncomingMessage): string {
    return String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
  }
  function limited(request: IncomingMessage): boolean {
    const key = hash(ip(request));
    const hour = now().getTime() - 3_600_000;
    const list = (recent.get(key) ?? []).filter((time) => time > hour);
    recent.set(key, list);
    return list.length >= 5;
  }

  async function bookingSteps(url: URL, response: ServerResponse) {
    const query = parseQuery(url);
    const service = query.service !== null ? booking.schedule.services[query.service] : undefined;
    const bookable = booking.schedule.services.map((_, index) => index).filter((index) => mastersFor(booking, index).length > 0);
    if (!service || !bookable.includes(query.service!)) {
      if (bookable.length === 1) return send(response, 303, '', 'text/plain', { Location: `/book?s=${bookable[0]}` });
      return send(response, 200, servicesPage(meta, booking));
    }
    const masters = mastersFor(booking, query.service!);
    const master = query.master === 'any' || masters.some((item) => item.key === query.master) ? query.master : null;
    if (!master) {
      if (masters.length === 1) return send(response, 303, '', 'text/plain', { Location: `/book?s=${query.service}&m=${masters[0]!.key}` });
      return send(response, 200, mastersPage(meta, booking, query.service!));
    }
    const current = busy(await load());
    const masterKey = master === 'any' ? null : master;
    const at = now();
    if (query.start && slotsFor(booking.schedule, service.name, masterKey, localDay(query.start, tz), current, at).some((slot) => slot.startsAt.getTime() === query.start!.getTime())) {
      return send(response, 200, confirmPage(meta, booking, { service: query.service!, master, start: query.start }));
    }
    const days = openDays(booking.schedule, service.name, masterKey, current, at);
    const day = query.day && days.some((item) => item.day === query.day) ? query.day : days[0]?.day ?? null;
    return send(response, 200, timesPage(meta, booking, { service: query.service!, master }, days, day, day ? slotsFor(booking.schedule, service.name, masterKey, day, current, at) : []));
  }

  async function bookingForm(request: IncomingMessage, response: ServerResponse) {
    if (!sameOrigin(request)) return send(response, 403, messagePage(meta, 'Запись не отправлена', 'Записаться можно только со страницы этого сайта.'));
    const raw = await body(request, 10_000);
    if (raw === null) return send(response, 413, messagePage(meta, 'Запись не отправлена', 'Слишком большой запрос.'));
    const parsed = parseBookingForm(raw);
    if (!parsed.ok && parsed.spam) return send(response, 303, '', 'text/plain', { Location: '/book' });
    if (!parsed.ok) {
      const { query } = parsed;
      if (query.service === null || !query.master || !query.start || !booking.schedule.services[query.service]) return send(response, 303, '', 'text/plain', { Location: '/book' });
      return send(response, 400, confirmPage(meta, booking, { service: query.service, master: query.master, start: query.start }, parsed.error, parsed.values));
    }
    if (limited(request)) return send(response, 429, messagePage(meta, 'Слишком много записей', 'Попробуйте позже или свяжитесь по контактам на сайте.'), 'text/html', { 'Retry-After': '3600' });
    const form = parsed.form;
    const service = booking.schedule.services[form.service];
    if (!service) return send(response, 303, '', 'text/plain', { Location: '/book' });
    const token = randomBytes(24).toString('base64url');
    const created = await exclusive(async () => {
      const list = await load();
      const at = now();
      const day = localDay(form.start, tz);
      const slot = slotsFor(booking.schedule, service.name, form.master === 'any' ? null : form.master, day, busy(list), at).find((item) => item.startsAt.getTime() === form.start.getTime());
      if (!slot) return null;
      const load_ = (key: string) => list.filter((item) => ACTIVE.has(item.status) && item.masterKey === key && localDay(new Date(item.startsAt), tz) === day).length;
      const masterKey = [...slot.masterKeys].sort((a, b) => load_(a) - load_(b))[0]!;
      const master = booking.schedule.masters.find((item) => item.key === masterKey)!;
      const row: StoredBooking = {
        id: randomBytes(8).toString('hex'), serviceName: service.name, minutes: service.minutes, price: booking.prices[service.name] ?? null, masterKey, masterName: master.name,
        startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), clientName: form.name, clientPhone: form.phone, comment: form.comment,
        status: 'booked', tokenHash: hash(token), createdAt: at.toISOString(),
      };
      list.push(row);
      await save();
      return row;
    });
    if (!created) {
      return send(response, 409, messagePage(meta, 'Это время уже заняли', 'Пока вы заполняли форму, это время забронировали. Выберите другое.', false)
        .replace('</main>', `<a class="button" href="/book?s=${form.service}&m=${encodeURIComponent(form.master)}&d=${localDay(form.start, tz)}">${tr('Выбрать другое время')}</a></main>`));
    }
    const key = hash(ip(request));
    recent.set(key, [...(recent.get(key) ?? []), now().getTime()]);
    send(response, 303, '', 'text/plain', { Location: `/book/b/${token}?new=1` });
    void notify(`${tr('Новая запись с сайта «{0}»', [meta.businessName])}\n${describe(created)}`);
  }

  const canCancel = (item: StoredBooking) => item.status === 'booked' && new Date(item.startsAt).getTime() - now().getTime() >= booking.schedule.rules.cancelHours * 3_600_000;
  const view = (item: StoredBooking) => ({ ...item, startsAt: new Date(item.startsAt), timezone: tz });

  async function manage(url: URL, response: ServerResponse, token: string) {
    const item = (await load()).find((row) => row.tokenHash === hash(token));
    if (!item) return send(response, 404, messagePage(meta, 'Запись не найдена', 'Ссылка неверная или запись уже удалена.'));
    send(response, 200, bookingPage(meta, view(item), token, canCancel(item), booking.schedule.rules.cancelHours, url.searchParams.get('new') === '1'), 'text/html', { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  async function cancel(request: IncomingMessage, response: ServerResponse) {
    if (!sameOrigin(request)) return send(response, 403, messagePage(meta, 'Не отменено', 'Отменить можно только со страницы этого сайта.'));
    const token = new URLSearchParams((await body(request, 2_000)) ?? '').get('token') ?? '';
    const changed = await exclusive(async () => {
      const item = (await load()).find((row) => row.tokenHash === hash(token));
      if (!item || !canCancel(item)) return null;
      item.status = 'cancelled_by_client';
      await save();
      return item;
    });
    send(response, 303, '', 'text/plain', { Location: `/book/b/${token}` });
    if (changed) void notify(`${tr('Клиент отменил запись на сайте «{0}»', [meta.businessName])}\n${describe(changed)}`);
  }

  /** Owner page behind HTTP Basic auth with ADMIN_PASSWORD (any user name). Disabled when the password is not set. */
  function authorized(request: IncomingMessage): boolean {
    if (!options.adminPassword) return false;
    const header = String(request.headers.authorization ?? '');
    const supplied = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    const a = Buffer.from(hash(supplied)); const b = Buffer.from(hash(options.adminPassword));
    return timingSafeEqual(a, b);
  }
  const statusText = (status: StoredBooking['status']): string => ({ booked: () => tr('записан'), cancelled_by_client: () => tr('отменил клиент'), cancelled_by_owner: () => tr('вы отменили'), done: () => tr('пришёл'), no_show: () => tr('не пришёл') })[status]();

  async function admin(request: IncomingMessage, response: ServerResponse) {
    if (!options.adminPassword) return send(response, 404, messagePage(meta, 'Страница выключена', 'Чтобы видеть записи, задайте ADMIN_PASSWORD в настройках сервера (см. README.md).'));
    if (!authorized(request)) return send(response, 401, messagePage(meta, 'Нужен пароль', 'Введите пароль владельца.', false), 'text/html', { 'WWW-Authenticate': 'Basic realm="bookings", charset="UTF-8"' });
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return send(response, 403, messagePage(meta, 'Не сохранено', 'Изменять записи можно только с этой страницы.'));
      const form = new URLSearchParams((await body(request, 2_000)) ?? '');
      const status = form.get('status');
      await exclusive(async () => {
        const item = (await load()).find((row) => row.id === form.get('id'));
        if (!item) return;
        const started = new Date(item.startsAt).getTime() <= now().getTime();
        if (status === 'cancelled_by_owner' && item.status === 'booked' && !started) item.status = status;
        else if ((status === 'done' || status === 'no_show') && started && ACTIVE.has(item.status)) item.status = status;
        else return;
        await save();
      });
      return send(response, 303, '', 'text/plain', { Location: '/admin' });
    }
    const since = now().getTime() - 12 * 3_600_000;
    const upcoming = (await load()).filter((item) => new Date(item.endsAt).getTime() >= since).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const button = (item: StoredBooking, status: string, label: string) => `<form method="post" action="/admin" style="display:inline"><input type="hidden" name="id" value="${item.id}"><input type="hidden" name="status" value="${status}"><button type="submit">${label}</button></form>`;
    const rowsHtml = upcoming.map((item) => {
      const started = new Date(item.startsAt).getTime() <= now().getTime();
      const actions = item.status === 'booked' && !started ? button(item, 'cancelled_by_owner', tr('Отменить')) : started && ACTIVE.has(item.status) ? `${button(item, 'done', tr('Пришёл'))} ${button(item, 'no_show', tr('Не пришёл'))}` : '';
      return `<li><p><strong>${escapeHtml(dayLabel(localDay(new Date(item.startsAt), tz)))}, ${localClock(new Date(item.startsAt), tz)}</strong> · ${escapeHtml(statusText(item.status))}</p><p>${escapeHtml(item.serviceName)} · ${escapeHtml(item.masterName)}</p><p>${escapeHtml(item.clientName)} · <a href="tel:${escapeHtml(item.clientPhone.replace(/[^\d+]/g, ''))}">${escapeHtml(item.clientPhone)}</a></p>${item.comment ? `<p>«${escapeHtml(item.comment)}»</p>` : ''}${actions}</li>`;
    }).join('');
    send(response, 200, page(meta, tr('Записи'), `<style>ul{list-style:none;padding:0}li{border:1px solid rgba(0,0,0,.15);border-radius:12px;padding:12px 14px;margin:10px 0}li p{margin:2px 0}button{font:inherit;padding:8px 14px;border-radius:10px;border:1px solid currentColor;background:#fff;cursor:pointer;margin-top:6px}</style><h1>${tr('Записи клиентов')}</h1>${rowsHtml ? `<ul>${rowsHtml}</ul>` : `<p>${tr('Предстоящих записей нет.')}</p>`}<p>${tr('Отменяя запись, позвоните клиенту — сам он сообщения не получит.')}</p>`), 'text/html', { 'Cache-Control': 'no-store' });
  }

  function privacy(): string {
    const months = Math.round((options.retentionDays ?? 365) / 30);
    const contacts = meta.ownerContacts.map((contact) => `<li>${escapeHtml(tr(contact.label))}: ${escapeHtml(contact.value)}</li>`).join('');
    return page(meta, tr('Как используются ваши данные'), `<h1>${tr('Как используются ваши данные')}</h1><p>${tr('Когда вы записываетесь онлайн, сайт «{0}» получает ваше имя, телефон, комментарий и выбранное время. Они нужны, чтобы вас записать и связаться по записи, и не используются для рассылок.', [escapeHtml(meta.businessName)])}</p><p>${tr('Данные хранятся на сервере владельца сайта не дольше {0} мес. после визита.', [months])}</p><p>${tr('Чтобы узнать, какие данные хранятся, или попросить удалить их, свяжитесь с владельцем:')}</p><ul>${contacts}</ul><a class="button" href="/">${tr('Вернуться на сайт')}</a>`);
  }

  async function cleanup(): Promise<number> {
    return exclusive(async () => {
      const list = await load();
      const cutoff = now().getTime() - (options.retentionDays ?? 365) * 86_400_000;
      const keep = list.filter((item) => new Date(item.endsAt).getTime() >= cutoff);
      const removed = list.length - keep.length;
      if (removed) { rows = keep; await save(); }
      return removed;
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://app.invalid');
    const route = url.pathname;
    if (route === '/admin') return admin(request, response);
    if (request.method === 'POST' && route === BOOKING_FORM_PATH) return bookingForm(request, response);
    if (request.method === 'POST' && route === BOOKING_CANCEL_PATH) return cancel(request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, '', 'text/plain', { Allow: 'GET, HEAD' });
    if (route === '/health') return send(response, 200, 'ok', 'text/plain', { 'Cache-Control': 'no-store' });
    if (route === '/book') return bookingSteps(url, response);
    const token = /^\/book\/b\/([A-Za-z0-9_-]{32})$/.exec(route);
    if (token) return manage(url, response, token[1]!);
    if (route === '/' || route === '/index.html') return send(response, 200, html, 'text/html', { 'Cache-Control': 'public, max-age=60' });
    if (route === '/privacy') return send(response, 200, privacy());
    if (route === '/robots.txt') return send(response, 200, 'User-agent: *\nAllow: /\nDisallow: /book\nDisallow: /admin\n', 'text/plain');
    return send(response, 404, messagePage(meta, 'Страница не найдена', 'Такой страницы на сайте нет.'));
  }

  const locale = contentLocale(meta.locale);
  const server = http.createServer((request, response) => {
    runWithLocale(locale, () => handle(request, response)).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) runWithLocale(locale, () => send(response, 500, messagePage(meta, 'Ошибка', 'Не удалось открыть страницу. Попробуйте позже.'))); else response.end();
    });
  });
  return { server, cleanup };
}

/** Entry point of the bundled file: reads config.json and index.html next to it. */
export async function main() {
  const dir = process.env.APP_DIR ?? path.dirname(new URL(import.meta.url).pathname);
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as ExportConfig;
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const telegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID } : null;
  const app = createBookingApp({ config, html, dataDir: process.env.DATA_DIR ?? path.join(dir, 'data'), adminPassword: process.env.ADMIN_PASSWORD || null, telegram });
  const port = Number(process.env.PORT ?? 8080);
  app.server.listen(port, '0.0.0.0', () => console.log(`Booking site on :${port}${process.env.ADMIN_PASSWORD ? '' : ' (ADMIN_PASSWORD is not set: /admin is off)'}`));
  void app.cleanup().catch(() => undefined);
  setInterval(() => { void app.cleanup().catch(() => undefined); }, 86_400_000).unref();
}
