// Serves published sites on <slug>.<SITES_BASE_DOMAIN> or on an owner's own domain, and accepts their forms.
// Runs as its own process (npm run start:sites) on a separate origin from the app and API.
import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SiteArtifact, SiteMeta } from '../journey/artifacts.js';
import { LEAD_FORM_PATH, pageCsp } from '../journey/site-renderer.js';
import { notifyLead } from '../notifications/lead-notifier.js';
import { sitesConfig, slugFromHost } from '../publishing/slug.js';
import { normalizeDomain } from '../publishing/domain.js';
import { emailConfig } from '../notifications/email.js';
import { sendDueReminders } from '../notifications/booking-reminders.js';
import { reportError } from '../observability/error-reporting.js';
import { messagePage, parseLeadForm, privacyPage, thanksPage } from './site-pages.js';
import { BOOKING_CANCEL_PATH, BOOKING_FORM_PATH, bookingPage, confirmPage, mastersFor, mastersPage, parseBookingForm, parseQuery, servicesPage, timesPage } from './booking-pages.js';
import { busyBetween, canClientCancel, createBooking, tokenHash } from './booking-store.js';
import { notifyBooking } from '../notifications/booking-notifier.js';
import { localDay as localDayOf, openDays, slotsFor } from '../journey/schedule.js';

export interface SitesServerOptions {
  baseDomain: string;
  urlFor: (slug: string) => string;
  trustProxy: boolean;
  ipSalt: string;
  retentionDays: number;
  /** Mail is configured, so the booking form offers an e-mail reminder. */
  remindersByEmail: boolean;
  https: boolean;
  perIpPerHour: number;
  perSitePerDay: number;
  notify: (leadId: string) => Promise<unknown>;
  notifyBooking: (bookingId: string, kind: 'created' | 'cancelled_by_client') => Promise<unknown>;
}

export function sitesOptionsFromEnv(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): SitesServerOptions {
  const config = sitesConfig(env);
  const retention = Number(env.LEAD_RETENTION_DAYS ?? 365);
  return {
    baseDomain: config.baseDomain, urlFor: config.urlFor, trustProxy: env.SITES_TRUST_PROXY === 'true',
    ipSalt: env.SITES_IP_HASH_SALT || randomBytes(16).toString('hex'),
    retentionDays: Number.isInteger(retention) && retention > 0 ? retention : 365,
    remindersByEmail: Boolean(emailConfig(env)) && env.BOOKING_EMAIL_REMINDERS !== 'off',
    https: config.urlTemplate.startsWith('https://'), perIpPerHour: 5, perSitePerDay: 200,
    notify: (leadId) => notifyLead(prisma, leadId),
    notifyBooking: (bookingId, kind) => notifyBooking(prisma, bookingId, kind),
  };
}

/** `hosts` are the addresses this site answers on: its BuildPath subdomain and, once DNS was checked, the owner's own domain. */
type Site = { publicationId: string; projectId: string; html: string; meta: SiteMeta | null; hasForm: boolean; canonical: string; hosts: string[] };

export function createSitesServer(prisma: PrismaClient, options: SitesServerOptions) {
  const cache = new Map<string, { site: Site | null; expires: number }>();

  async function loadSite(where: { slug: string } | { customDomain: string }): Promise<Site | null> {
    const key = 'slug' in where ? `s:${where.slug}` : `d:${where.customDomain}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.site;
    const publication = await prisma.sitePublication.findUnique({
      where, select: { id: true, projectId: true, status: true, buildVersionId: true, slug: true, customDomain: true, domainStatus: true },
    });
    let site: Site | null = null;
    const ownDomain = publication?.domainStatus === 'active' ? publication.customDomain : null;
    if (publication?.status === 'live' && ('slug' in where || ownDomain)) {
      const version = await prisma.stageArtifactVersion.findUnique({ where: { id: publication.buildVersionId }, select: { content: true } });
      const artifact = version?.content as unknown as SiteArtifact | undefined;
      if (artifact?.html) {
        const platformUrl = options.urlFor(publication.slug);
        const canonical = ownDomain ? `${options.https ? 'https' : 'http'}://${ownDomain}` : platformUrl;
        site = {
          publicationId: publication.id, projectId: publication.projectId, html: artifact.html, meta: artifact.meta ?? null, hasForm: Boolean(artifact.meta?.hasForm),
          canonical, hosts: [new URL(platformUrl).host, ...(ownDomain ? [ownDomain] : [])],
        };
      }
    }
    cache.set(key, { site, expires: Date.now() + 15_000 });
    return site;
  }

  /** A BuildPath subdomain first; anything else may be an owner's own domain that points here. */
  async function siteForHost(rawHost: string | undefined): Promise<Site | null> {
    const slug = slugFromHost(rawHost, options.baseDomain);
    if (slug) return loadSite({ slug });
    const host = normalizeDomain(String(rawHost ?? '').replace(/:\d+$/, ''));
    if (!host || host === options.baseDomain || host.endsWith(`.${options.baseDomain}`)) return null;
    return loadSite({ customDomain: host });
  }

  function send(response: ServerResponse, status: number, body: string, type: string, hasForm = false, extra: Record<string, string> = {}) {
    response.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Security-Policy': `${pageCsp(hasForm)}; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...(options.https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      ...extra,
    });
    response.end(body);
  }

  /** Serves only photos that the published page itself shows, so unpublished photos in the project library stay private. */
  async function sendImage(response: ServerResponse, site: Site, id: string, head: boolean) {
    const notFound = () => send(response, 404, 'Not found', 'text/plain');
    if (!site.html.includes(`/img/${id}.webp`)) return notFound();
    const row = await prisma.projectImage.findFirst({ where: { id, projectId: site.projectId }, select: { data: true, sha256: true } });
    if (!row) return notFound();
    const data = Buffer.from(row.data);
    response.writeHead(200, {
      'Content-Type': 'image/webp', 'Content-Length': String(data.length), 'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${row.sha256}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.end(head ? undefined : data);
  }

  function clientIp(request: IncomingMessage): string {
    const forwarded = options.trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return forwarded || request.socket.remoteAddress || 'unknown';
  }

  async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleLead(request: IncomingMessage, response: ServerResponse, site: Site) {
    if (!site.hasForm) return send(response, 404, messagePage(site.meta, 'Страница не найдена', 'На этом сайте нет формы заявки.'), 'text/html');
    if (!sameOrigin(request, site)) {
      return send(response, 403, messagePage(site.meta, 'Заявка не отправлена', 'Форму можно отправить только со страницы этого сайта.'), 'text/html');
    }
    if (!String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return send(response, 415, messagePage(site.meta, 'Заявка не отправлена', 'Неподдерживаемый формат формы.'), 'text/html');
    }
    const raw = await readBody(request, 10_000);
    if (raw === null) return send(response, 413, messagePage(site.meta, 'Заявка не отправлена', 'Заявка слишком большая. Сократите сообщение.'), 'text/html');
    const parsed = parseLeadForm(raw);
    if (!parsed.ok && parsed.spam) return send(response, 303, '', 'text/plain', false, { Location: '/thanks' });
    if (!parsed.ok) return send(response, 400, messagePage(site.meta, 'Проверьте заявку', parsed.error), 'text/html');
    const ipHash = createHash('sha256').update(`${options.ipSalt}:${clientIp(request)}`).digest('hex');
    const [perIp, perSite] = await Promise.all([
      prisma.siteLead.count({ where: { publicationId: site.publicationId, ipHash, createdAt: { gte: new Date(Date.now() - 3_600_000) } } }),
      prisma.siteLead.count({ where: { publicationId: site.publicationId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    ]);
    if (perIp >= options.perIpPerHour || perSite >= options.perSitePerDay) {
      return send(response, 429, messagePage(site.meta, 'Слишком много заявок', 'Мы уже получили ваши заявки. Попробуйте позже или свяжитесь по контактам на сайте.'), 'text/html', false, { 'Retry-After': '3600' });
    }
    const lead = await prisma.siteLead.create({
      data: { projectId: site.projectId, publicationId: site.publicationId, name: parsed.lead.name, contact: parsed.lead.contact, message: parsed.lead.message, consentAt: new Date(), ipHash },
      select: { id: true },
    });
    send(response, 303, '', 'text/plain', false, { Location: '/thanks' });
    void options.notify(lead.id).catch(() => undefined);
  }

  function sameOrigin(request: IncomingMessage, site: Site): boolean {
    const origin = request.headers.origin;
    if (!origin || origin === 'null') return true;
    try { return site.hosts.includes(new URL(origin).host); } catch { return false; }
  }

  /** Booking steps are plain links and one form, so they work without scripts and with the page CSP. */
  async function handleBookingPage(url: URL, response: ServerResponse, site: Site) {
    const meta = site.meta!;
    const config = meta.booking!;
    const html = (body: string, status = 200) => send(response, status, body, 'text/html', true, { 'Cache-Control': 'no-store' });
    const query = parseQuery(url);
    const service = query.service !== null ? config.schedule.services[query.service] : undefined;
    const bookable = config.schedule.services.map((_, index) => index).filter((index) => mastersFor(config, index).length > 0);
    if (!service || !bookable.includes(query.service!)) {
      if (bookable.length === 1) return send(response, 303, '', 'text/plain', false, { Location: `/book?s=${bookable[0]}` });
      return html(servicesPage(meta, config));
    }
    const masters = mastersFor(config, query.service!);
    const master = query.master === 'any' || masters.some((item) => item.key === query.master) ? query.master : null;
    if (!master) {
      if (masters.length === 1) return send(response, 303, '', 'text/plain', false, { Location: `/book?s=${query.service}&m=${masters[0]!.key}` });
      return html(mastersPage(meta, config, query.service!));
    }
    const now = new Date();
    const horizonEnd = new Date(now.getTime() + (config.schedule.rules.horizonDays + 1) * 86_400_000);
    const busy = await busyBetween(prisma, site.publicationId, new Date(now.getTime() - 86_400_000), horizonEnd);
    const masterKey = master === 'any' ? null : master;
    if (query.start) {
      const free = slotsFor(config.schedule, service.name, masterKey, localDayOf(query.start, config.schedule.timezone), busy, now).some((slot) => slot.startsAt.getTime() === query.start!.getTime());
      if (free) return html(confirmPage(meta, config, { service: query.service!, master, start: query.start }, null, {}, options.remindersByEmail));
    }
    const days = openDays(config.schedule, service.name, masterKey, busy, now);
    const day = query.day && days.some((item) => item.day === query.day) ? query.day : days[0]?.day ?? null;
    const slots = day ? slotsFor(config.schedule, service.name, masterKey, day, busy, now) : [];
    return html(timesPage(meta, config, { service: query.service!, master }, days, day, slots));
  }

  async function handleBookingForm(request: IncomingMessage, response: ServerResponse, site: Site) {
    const meta = site.meta!;
    const config = meta.booking!;
    if (!sameOrigin(request, site)) return send(response, 403, messagePage(meta, 'Запись не отправлена', 'Записаться можно только со страницы этого сайта.'), 'text/html');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(response, 415, messagePage(meta, 'Запись не отправлена', 'Неподдерживаемый формат формы.'), 'text/html');
    const raw = await readBody(request, 10_000);
    if (raw === null) return send(response, 413, messagePage(meta, 'Запись не отправлена', 'Слишком большой запрос.'), 'text/html');
    const parsed = parseBookingForm(raw);
    if (!parsed.ok && parsed.spam) return send(response, 303, '', 'text/plain', false, { Location: '/book' });
    if (!parsed.ok) {
      const { query } = parsed;
      if (query.service === null || !query.master || !query.start || !config.schedule.services[query.service]) return send(response, 303, '', 'text/plain', false, { Location: '/book' });
      return send(response, 400, confirmPage(meta, config, { service: query.service, master: query.master, start: query.start }, parsed.error, parsed.values, options.remindersByEmail), 'text/html', true);
    }
    const ipHash = createHash('sha256').update(`${options.ipSalt}:${clientIp(request)}`).digest('hex');
    const [perIp, perSite] = await Promise.all([
      prisma.booking.count({ where: { publicationId: site.publicationId, ipHash, createdAt: { gte: new Date(Date.now() - 3_600_000) } } }),
      prisma.booking.count({ where: { publicationId: site.publicationId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    ]);
    if (perIp >= options.perIpPerHour || perSite >= options.perSitePerDay) {
      return send(response, 429, messagePage(meta, 'Слишком много записей', 'С этого устройства уже было несколько записей. Попробуйте позже или свяжитесь по контактам на сайте.'), 'text/html', false, { 'Retry-After': '3600' });
    }
    const result = await createBooking(prisma, site, config, options.remindersByEmail ? parsed.form : { ...parsed.form, email: null }, ipHash);
    if (!result.ok) {
      const location = `/book?s=${parsed.form.service}&m=${encodeURIComponent(parsed.form.master)}&d=${localDayOf(parsed.form.start, config.schedule.timezone)}`;
      return send(response, 409, messagePage(meta, 'Это время уже заняли', 'Пока вы заполняли форму, это время забронировали. Выберите другое — откроем свободное время на этот день.', false)
        .replace('</main>', `<a class="button" href="${location}">Выбрать другое время</a></main>`), 'text/html');
    }
    send(response, 303, '', 'text/plain', false, { Location: `/book/b/${result.token}?new=1` });
    void options.notifyBooking(result.id, 'created').catch(() => undefined);
  }

  async function bookingByToken(site: Site, token: string) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    return prisma.booking.findFirst({
      where: { tokenHash: tokenHash(token), publicationId: site.publicationId },
      select: { id: true, serviceName: true, masterName: true, startsAt: true, minutes: true, price: true, timezone: true, status: true, clientName: true },
    });
  }

  async function handleBookingView(url: URL, response: ServerResponse, site: Site, token: string) {
    const booking = await bookingByToken(site, token);
    if (!booking) return send(response, 404, messagePage(site.meta, 'Запись не найдена', 'Ссылка неверная или запись уже удалена.'), 'text/html');
    const cancelHours = site.meta!.booking!.schedule.rules.cancelHours;
    send(response, 200, bookingPage(site.meta!, booking, token, canClientCancel(booking, cancelHours), cancelHours, url.searchParams.get('new') === '1'), 'text/html', true,
      { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  }

  async function handleBookingCancel(request: IncomingMessage, response: ServerResponse, site: Site) {
    if (!sameOrigin(request, site)) return send(response, 403, messagePage(site.meta, 'Не отменено', 'Отменить можно только со страницы этого сайта.'), 'text/html');
    const raw = await readBody(request, 2_000);
    const token = new URLSearchParams(raw ?? '').get('token') ?? '';
    const booking = await bookingByToken(site, token);
    if (!booking) return send(response, 404, messagePage(site.meta, 'Запись не найдена', 'Ссылка неверная или запись уже удалена.'), 'text/html');
    if (!canClientCancel(booking, site.meta!.booking!.schedule.rules.cancelHours)) return send(response, 303, '', 'text/plain', false, { Location: `/book/b/${token}` });
    const updated = await prisma.booking.updateMany({ where: { id: booking.id, status: 'booked' }, data: { status: 'cancelled_by_client', cancelledAt: new Date() } });
    await prisma.booking.updateMany({ where: { id: booking.id, reminderStatus: 'pending' }, data: { reminderStatus: 'skipped', clientEmail: null, cancelLinkSealed: null } });
    send(response, 303, '', 'text/plain', false, { Location: `/book/b/${token}` });
    if (updated.count) void options.notifyBooking(booking.id, 'cancelled_by_client').catch(() => undefined);
  }

  /**
   * Caddy asks this before issuing an on-demand TLS certificate for a host: only subdomains of live sites and own domains whose DNS was checked get one,
   * so nobody can make the server request certificates for arbitrary names. Both answers reveal only what the site itself shows.
   */
  async function handleService(path: string, url: URL, response: ServerResponse): Promise<boolean> {
    if (path === '/__caddy/ask') {
      const site = await siteForHost(url.searchParams.get('domain') ?? '');
      send(response, site ? 200 : 404, site ? 'ok' : 'unknown', 'text/plain', false, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (path === '/__health') {
      try {
        await prisma.$queryRaw`SELECT 1`;
        send(response, 200, 'ok', 'text/plain', false, { 'Cache-Control': 'no-store' });
      } catch {
        send(response, 503, 'database unavailable', 'text/plain', false, { 'Cache-Control': 'no-store' });
      }
      return true;
    }
    return false;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://site.invalid');
    const path = url.pathname;
    if (request.method === 'GET' && (await handleService(path, url, response))) return;
    const site = await siteForHost(request.headers.host);
    if (!site) return send(response, 404, messagePage(null, 'Сайт не найден', 'По этому адресу сайта нет или он снят с публикации.', false), 'text/html');
    if (request.method === 'POST' && path === LEAD_FORM_PATH) return handleLead(request, response, site);
    const booking = Boolean(site.meta?.booking);
    if (request.method === 'POST' && path === BOOKING_FORM_PATH) return booking ? handleBookingForm(request, response, site) : send(response, 404, messagePage(site.meta, 'Страница не найдена', 'На этом сайте нет онлайн-записи.'), 'text/html');
    if (request.method === 'POST' && path === BOOKING_CANCEL_PATH) return booking ? handleBookingCancel(request, response, site) : send(response, 404, messagePage(site.meta, 'Страница не найдена', 'На этом сайте нет онлайн-записи.'), 'text/html');
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, '', 'text/plain', false, { Allow: 'GET, HEAD' });
    const cacheHeaders = { 'Cache-Control': 'public, max-age=60' };
    const image = /^\/img\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/.exec(path);
    if (image) return sendImage(response, site, image[1]!, request.method === 'HEAD');
    if (booking && path === '/book') return handleBookingPage(url, response, site);
    const manage = /^\/book\/b\/([A-Za-z0-9_-]{32})$/.exec(path);
    if (booking && manage) return handleBookingView(url, response, site, manage[1]!);
    switch (path) {
      case '/': return send(response, 200, site.html, 'text/html', site.hasForm, cacheHeaders);
      case '/privacy': return send(response, 200, privacyPage(site.meta, options.retentionDays, options.remindersByEmail), 'text/html', false, cacheHeaders);
      case '/thanks': return send(response, 200, thanksPage(site.meta), 'text/html', false, { 'Cache-Control': 'no-store' });
      case '/robots.txt': return send(response, 200, `User-agent: *\nAllow: /\nDisallow: /thanks\nDisallow: /book\nSitemap: ${site.canonical}/sitemap.xml\n`, 'text/plain', false, cacheHeaders);
      case '/sitemap.xml': return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.canonical}/</loc></url></urlset>\n`, 'application/xml', false, cacheHeaders);
      default: return send(response, 404, messagePage(site.meta, 'Страница не найдена', 'Такой страницы на сайте нет.'), 'text/html');
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      reportError(error, { service: 'sites' });
      if (!response.headersSent) send(response, 500, messagePage(null, 'Ошибка', 'Не удалось открыть страницу. Попробуйте позже.'), 'text/html');
      else response.end();
    });
  });

  /** Deletes leads older than the retention period; returns the number removed. */
  async function cleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - options.retentionDays * 86_400_000);
    const result = await prisma.siteLead.deleteMany({ where: { createdAt: { lt: cutoff } } });
    const bookings = await prisma.booking.deleteMany({ where: { endsAt: { lt: cutoff } } });
    return result.count + bookings.count;
  }

  /** Sends client reminders that are due; the link points at the site's own domain when it is connected. */
  function reminders(now = new Date()) {
    return sendDueReminders(prisma, (publication) => (publication.domainStatus === 'active' && publication.customDomain
      ? `${options.https ? 'https' : 'http'}://${publication.customDomain}` : options.urlFor(publication.slug)), now);
  }

  return { server, cleanup, reminders, invalidate: (slug: string) => { cache.delete(`s:${slug}`); for (const key of cache.keys()) if (key.startsWith('d:')) cache.delete(key); } };
}
