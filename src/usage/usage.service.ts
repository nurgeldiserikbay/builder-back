// Usage analytics of a launched application (builder-docs PRODUCT_LIFECYCLE.md §4.12, «Работа и обратная связь»): how many
// people use it, which screens they open and how often they reach the main actions. The owner turns it on; the AI agent
// then adds a few lines that send «a screen was opened» and «an action was done» to a public address with the project's
// token. The platform keeps only daily counters:
// - no cookies or storage in the browser, no user ids, no IP addresses, no texts people typed;
// - a visitor is counted once a day by a hash of the address and browser with a salt that changes every day and is
//   deleted together with the hashes, so nobody can tell who visited or follow a person from one day to the next.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { RateLimiter } from '../security/rate-limit.js';

/** A page view every few seconds from one address is plenty; the whole application is capped per day. */
export const USAGE_RATE = { perIp: { max: 600, windowMs: 60 * 60_000 }, perApp: { max: 50_000, windowMs: 24 * 60 * 60_000 } };
/** Distinct screens and actions a day; past that, the rest is counted together, so nobody can fill the table. */
export const USAGE_LIMITS = { names: 60, path: 80, action: 40, keepDays: 400 };
export const OTHER = '…';
const limits = new RateLimiter();
const TOKEN = /^[A-Za-z0-9_-]{24,48}$/;
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|monitor/i;

export const newUsageToken = () => randomBytes(24).toString('base64url');

export function usageUrl(token: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/api/v1/usage/${token}` : null;
}

/** The UTC day as a date, as Postgres DATE keeps it. */
export const dayOf = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/**
 * A screen path without what may identify a person: no query or hash, ids replaced by «:id» (numbers, uuids, long
 * tokens), lower case, at most 80 characters.
 */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let path = raw.trim().split(/[?#]/)[0]!;
  if (!path.startsWith('/')) return null;
  path = path.split('/').map((part) => {
    if (!part) return part;
    if (/^\d+$/.test(part) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || (part.length >= 16 && /\d/.test(part))) return ':id';
    if (part.includes('@')) return ':id';
    return part.toLowerCase();
  }).join('/');
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return /^[\p{L}\p{N}/:._~-]+$/u.test(path) ? path.slice(0, USAGE_LIMITS.path) : null;
}

/** An action name: a few words the agent chose («заявка отправлена»), not something a person typed. */
export function cleanAction(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return name && name.length <= USAGE_LIMITS.action && /^[\p{L}\p{N} _-]+$/u.test(name) ? name : null;
}

/** What the application sends: «view» with a path, or «action» with its name. null — nothing to count. */
export function readUsage(raw: unknown): { kind: 'view' | 'action'; name: string } | null {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (body.kind === 'action') { const name = cleanAction(body.name); return name ? { kind: 'action', name } : null; }
  if (body.kind === 'view' || body.kind === undefined) { const name = cleanPath(body.name); return name ? { kind: 'view', name } : null; }
  return null;
}

export const visitorHash = (salt: string, collectorId: string, ip: string, agent: string) => createHash('sha256').update(`${salt}|${collectorId}|${ip}|${agent}`).digest('hex').slice(0, 32);

type Row = { day: Date; kind: string; name: string; count: number };

/** The owner's report: per day views, visitors and actions; the most opened screens and the actions over the period. */
export function usageReport(rows: Row[], days: number, today: Date) {
  const list = Array.from({ length: days }, (_, index) => {
    const day = new Date(today.getTime() - (days - 1 - index) * 86_400_000);
    const of = (kind: string) => rows.filter((row) => row.kind === kind && row.day.getTime() === day.getTime()).reduce((sum, row) => sum + row.count, 0);
    return { day: day.toISOString().slice(0, 10), views: of('view'), visitors: of('visitors'), actions: of('action') };
  });
  const top = (kind: string, max: number) => {
    const sums = new Map<string, number>();
    for (const row of rows) if (row.kind === kind) sums.set(row.name, (sums.get(row.name) ?? 0) + row.count);
    return [...sums].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, max);
  };
  const total = (key: 'views' | 'visitors' | 'actions') => list.reduce((sum, day) => sum + day[key], 0);
  return { days: list, totals: { views: total('views'), visitors: total('visitors'), actions: total('actions') }, screens: top('view', 10), actions: top('action', 10) };
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  private async collector(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access);
    if (ctx.type.key !== 'web_app') throw new NotFoundException('USAGE_NOT_FOR_PROJECT');
    return this.prisma.usageCollector.findUnique({ where: { projectId } });
  }

  /** The report for the last 7 or 30 days; also says whether collecting is on and where the application sends. */
  async get(userId: string, projectId: string, rawDays: unknown) {
    const days = rawDays === '30' || rawDays === 30 ? 30 : 7;
    const collector = await this.collector(userId, projectId, 'read');
    const today = dayOf(new Date());
    const from = new Date(today.getTime() - (days - 1) * 86_400_000);
    const rows = collector ? await this.prisma.usageDay.findMany({ where: { collectorId: collector.id, day: { gte: from } }, select: { day: true, kind: true, name: true, count: true } }) : [];
    const first = collector ? await this.prisma.usageDay.findFirst({ where: { collectorId: collector.id }, orderBy: { day: 'asc' }, select: { day: true } }) : null;
    return { data: {
      enabled: collector?.enabled ?? false, url: collector ? usageUrl(collector.token) : null, configured: Boolean(process.env.PUBLIC_API_URL),
      period: days, since: first?.day.toISOString().slice(0, 10) ?? null, ...usageReport(rows, days, today),
    } };
  }

  /** On, off, or a new address (the old one stops counting at once). Turning off keeps what was counted. */
  async set(userId: string, projectId: string, input: { enabled?: unknown; renew?: unknown }) {
    const existing = await this.collector(userId, projectId, 'write');
    if (typeof input.enabled !== 'boolean' && input.renew !== true) throw new BadRequestException('INVALID_BODY');
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true;
    const collector = existing
      ? await this.prisma.usageCollector.update({ where: { projectId }, data: { enabled, ...(input.renew === true ? { token: newUsageToken() } : {}) } })
      : await this.prisma.usageCollector.create({ data: { projectId, token: newUsageToken(), enabled } });
    await this.core.event(this.prisma, projectId, userId, 'usage_collector_changed', null, { enabled, renewed: input.renew === true });
    return { data: { enabled: collector.enabled, url: usageUrl(collector.token), configured: Boolean(process.env.PUBLIC_API_URL) } };
  }

  /** The address the agent writes into the application, when the owner turned analytics on. */
  async urlFor(projectId: string): Promise<string | null> {
    const collector = await this.prisma.usageCollector.findUnique({ where: { projectId }, select: { token: true, enabled: true } });
    return collector?.enabled ? usageUrl(collector.token) : null;
  }

  /** Today's salt; the first visit of a new day makes it and deletes yesterday's salts and visitor hashes. */
  private async salt(today: Date): Promise<string> {
    const found = await this.prisma.usageSalt.findUnique({ where: { day: today } });
    if (found) return found.salt;
    const created = await this.prisma.usageSalt.upsert({ where: { day: today }, update: {}, create: { day: today, salt: randomBytes(32).toString('hex') } });
    await this.prisma.usageSalt.deleteMany({ where: { day: { lt: today } } });
    await this.prisma.usageVisitor.deleteMany({ where: { day: { lt: today } } });
    await this.prisma.usageDay.deleteMany({ where: { day: { lt: new Date(today.getTime() - USAGE_LIMITS.keepDays * 86_400_000) } } });
    return created.salt;
  }

  private async bump(collectorId: string, day: Date, kind: string, name: string) {
    await this.prisma.$executeRaw`
      INSERT INTO usage_days (collector_id, day, kind, name, count) VALUES (${collectorId}::uuid, ${day}::date, ${kind}, ${name}, 1)
      ON CONFLICT (collector_id, day, kind, name) DO UPDATE SET count = usage_days.count + 1`;
  }

  /** The public side. Unknown or turned-off addresses, bots and malformed beacons are answered the same and not counted. */
  async receive(token: string, ip: string, agent: string, raw: unknown, now = new Date()): Promise<void> {
    if (!TOKEN.test(token)) throw new NotFoundException('USAGE_NOT_FOUND');
    const collector = await this.prisma.usageCollector.findUnique({ where: { token }, select: { id: true, enabled: true } });
    if (!collector?.enabled) throw new NotFoundException('USAGE_NOT_FOUND');
    await limits.take('usage-ip', `${token}:${ip}`, USAGE_RATE.perIp, 'USAGE_TOO_MANY');
    await limits.take('usage-app', token, USAGE_RATE.perApp, 'USAGE_TOO_MANY');
    if (!agent || BOT.test(agent)) return;
    const hit = readUsage(raw);
    if (!hit) return;
    const today = dayOf(now);
    // A new name past the daily limit is counted together with the other rare ones.
    const known = await this.prisma.usageDay.findUnique({ where: { collectorId_day_kind_name: { collectorId: collector.id, day: today, kind: hit.kind, name: hit.name } }, select: { id: true } });
    const name = known || await this.prisma.usageDay.count({ where: { collectorId: collector.id, day: today, kind: hit.kind } }) < USAGE_LIMITS.names ? hit.name : OTHER;
    await this.bump(collector.id, today, hit.kind, name);
    if (hit.kind !== 'view') return;
    const hash = visitorHash(await this.salt(today), collector.id, ip, agent);
    const fresh = await this.prisma.usageVisitor.createMany({ data: [{ collectorId: collector.id, day: today, hash }], skipDuplicates: true });
    if (fresh.count) await this.bump(collector.id, today, 'visitors', '');
  }
}
