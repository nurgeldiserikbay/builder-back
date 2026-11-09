// Serves published sites on <slug>.<SITES_BASE_DOMAIN> and accepts their lead forms.
// Runs as its own process (npm run start:sites) on a separate origin from the app and API.
import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { SiteArtifact, SiteMeta } from '../journey/artifacts.js';
import { LEAD_FORM_PATH, pageCsp } from '../journey/site-renderer.js';
import { notifyLead } from '../notifications/lead-notifier.js';
import { sitesConfig, slugFromHost } from '../publishing/slug.js';
import { messagePage, parseLeadForm, privacyPage, thanksPage } from './site-pages.js';

export interface SitesServerOptions {
  baseDomain: string;
  urlFor: (slug: string) => string;
  trustProxy: boolean;
  ipSalt: string;
  retentionDays: number;
  https: boolean;
  perIpPerHour: number;
  perSitePerDay: number;
  notify: (leadId: string) => Promise<unknown>;
}

export function sitesOptionsFromEnv(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): SitesServerOptions {
  const config = sitesConfig(env);
  const retention = Number(env.LEAD_RETENTION_DAYS ?? 365);
  return {
    baseDomain: config.baseDomain, urlFor: config.urlFor, trustProxy: env.SITES_TRUST_PROXY === 'true',
    ipSalt: env.SITES_IP_HASH_SALT || randomBytes(16).toString('hex'),
    retentionDays: Number.isInteger(retention) && retention > 0 ? retention : 365,
    https: config.urlTemplate.startsWith('https://'), perIpPerHour: 5, perSitePerDay: 200,
    notify: (leadId) => notifyLead(prisma, leadId),
  };
}

type Site = { publicationId: string; projectId: string; html: string; meta: SiteMeta | null; hasForm: boolean };

export function createSitesServer(prisma: PrismaClient, options: SitesServerOptions) {
  const cache = new Map<string, { site: Site | null; expires: number }>();

  async function loadSite(slug: string): Promise<Site | null> {
    const cached = cache.get(slug);
    if (cached && cached.expires > Date.now()) return cached.site;
    const publication = await prisma.sitePublication.findUnique({ where: { slug }, select: { id: true, projectId: true, status: true, buildVersionId: true } });
    let site: Site | null = null;
    if (publication?.status === 'live') {
      const version = await prisma.stageArtifactVersion.findUnique({ where: { id: publication.buildVersionId }, select: { content: true } });
      const artifact = version?.content as unknown as SiteArtifact | undefined;
      if (artifact?.html) {
        site = { publicationId: publication.id, projectId: publication.projectId, html: artifact.html, meta: artifact.meta ?? null, hasForm: Boolean(artifact.meta?.hasForm) };
      }
    }
    cache.set(slug, { site, expires: Date.now() + 15_000 });
    return site;
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

  async function handleLead(request: IncomingMessage, response: ServerResponse, slug: string, site: Site) {
    if (!site.hasForm) return send(response, 404, messagePage(site.meta, 'Страница не найдена', 'На этом сайте нет формы заявки.'), 'text/html');
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && new URL(origin).host !== new URL(options.urlFor(slug)).host) {
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

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const slug = slugFromHost(request.headers.host, options.baseDomain);
    const path = new URL(request.url ?? '/', 'http://site.invalid').pathname;
    const site = slug ? await loadSite(slug) : null;
    if (!slug || !site) return send(response, 404, messagePage(null, 'Сайт не найден', 'По этому адресу сайта нет или он снят с публикации.', false), 'text/html');
    if (request.method === 'POST' && path === LEAD_FORM_PATH) return handleLead(request, response, slug, site);
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, '', 'text/plain', false, { Allow: 'GET, HEAD' });
    const cacheHeaders = { 'Cache-Control': 'public, max-age=60' };
    switch (path) {
      case '/': return send(response, 200, site.html, 'text/html', site.hasForm, cacheHeaders);
      case '/privacy': return send(response, 200, privacyPage(site.meta, options.retentionDays), 'text/html', false, cacheHeaders);
      case '/thanks': return send(response, 200, thanksPage(site.meta), 'text/html', false, { 'Cache-Control': 'no-store' });
      case '/robots.txt': return send(response, 200, `User-agent: *\nAllow: /\nDisallow: /thanks\nSitemap: ${options.urlFor(slug)}/sitemap.xml\n`, 'text/plain', false, cacheHeaders);
      case '/sitemap.xml': return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${options.urlFor(slug)}/</loc></url></urlset>\n`, 'application/xml', false, cacheHeaders);
      default: return send(response, 404, messagePage(site.meta, 'Страница не найдена', 'Такой страницы на сайте нет.'), 'text/html');
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, messagePage(null, 'Ошибка', 'Не удалось открыть страницу. Попробуйте позже.'), 'text/html');
      else response.end();
    });
  });

  /** Deletes leads older than the retention period; returns the number removed. */
  async function cleanup(): Promise<number> {
    const result = await prisma.siteLead.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - options.retentionDays * 86_400_000) } } });
    return result.count;
  }

  return { server, cleanup, invalidate: (slug: string) => cache.delete(slug) };
}
