// Page views of published sites, counted without cookies, IP addresses or device data: only the page, the day and
// the host of the site the visitor came from. Views are added up in memory and written once a minute.
import type { IncomingMessage } from 'node:http';
import type { PrismaClient } from '../generated/prisma/client.js';

/** Crawlers, link previews and monitoring are not visitors. */
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|vkshare|monitor|uptime|curl|wget|python|go-http|headless|lighthouse/i;

/** Whether this request is a person opening a page. Prefetches and requests without a browser signature are skipped. */
export function countable(request: Pick<IncomingMessage, 'method' | 'headers'>): boolean {
  if (request.method !== 'GET') return false;
  const agent = String(request.headers['user-agent'] ?? '');
  if (!agent || BOT.test(agent)) return false;
  const purpose = String(request.headers['sec-purpose'] ?? request.headers['purpose'] ?? '');
  if (/prefetch|prerender/i.test(purpose)) return false;
  return true;
}

/** Host of the referring site, or «direct». The full address is never kept: it can carry search terms or tokens. */
export function sourceOf(referer: string | undefined, ownHosts: string[]): string {
  if (!referer) return 'direct';
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, '');
    if (!host || ownHosts.some((own) => own.toLowerCase().replace(/^www\./, '') === host)) return 'direct';
    return host.slice(0, 100);
  } catch {
    return 'direct';
  }
}

/** Calendar day in the given time zone, as YYYY-MM-DD. */
export function dayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

type Key = string;
const keyOf = (projectId: string, day: string, path: string, source: string): Key => JSON.stringify([projectId, day, path, source]);

export class VisitCounter {
  private pending = new Map<Key, number>();

  constructor(private readonly prisma: Pick<PrismaClient, '$executeRaw'>, private readonly timeZone: string) {}

  add(projectId: string, path: string, source: string, now = new Date()) {
    const key = keyOf(projectId, dayIn(this.timeZone, now), path.slice(0, 200), source);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }

  /** Writes what has been counted. On a failure the counts go back into the buffer for the next try. */
  async flush(): Promise<number> {
    if (!this.pending.size) return 0;
    const batch = this.pending;
    this.pending = new Map();
    let written = 0;
    for (const [key, views] of batch) {
      const [projectId, day, path, source] = JSON.parse(key) as [string, string, string, string];
      try {
        await this.prisma.$executeRaw`
          INSERT INTO site_visit_counts (project_id, day, path, source, views)
          VALUES (${projectId}::uuid, ${day}::date, ${path}, ${source}, ${views})
          ON CONFLICT (project_id, day, path, source) DO UPDATE SET views = site_visit_counts.views + EXCLUDED.views`;
        written += views;
      } catch (error) {
        // The project was deleted meanwhile: nothing to count it against. Anything else is retried next time.
        if (/23503|foreign key/i.test(String((error as { message?: string })?.message ?? error))) continue;
        this.pending.set(key, (this.pending.get(key) ?? 0) + views);
      }
    }
    return written;
  }

  get size() { return this.pending.size; }
}
