// Sliding-window limits for account endpoints (sign-in, registration, recovery mail, uploads).
//
// Where the counters live is a deployment decision (RATE_LIMIT_STORE):
// - memory (default): each API process counts on its own. Fine for one instance; with several, each limits separately.
// - database: counters in PostgreSQL, shared by every API instance, so limits hold however many copies run.
// Keys are hashed so e-mail addresses and IP addresses are never stored in clear text.
import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';

export interface Limit { max: number; windowMs: number }

/** Where attempts are counted. All methods take an already hashed key. */
export interface RateLimitStore {
  count(key: string, since: number): Promise<number>;
  add(key: string, at: number, expiresAt: number): Promise<void>;
  /** Adds the attempt only when fewer than `max` are already counted since `since`; true when it was added. */
  addIfUnder(key: string, at: number, since: number, max: number, expiresAt: number): Promise<boolean>;
  clear(key: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private writes = 0;
  constructor(private readonly now: () => number = Date.now) {}

  private recent(key: string, since: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  async count(key: string, since: number) { return this.recent(key, since).length; }
  async add(key: string, at: number, _expiresAt?: number) {
    const list = this.hits.get(key) ?? [];
    list.push(at);
    this.hits.set(key, list);
    if (++this.writes % 500 === 0) this.sweep();
  }
  async addIfUnder(key: string, at: number, since: number, max: number, expiresAt: number) {
    if (this.recent(key, since).length >= max) return false;
    await this.add(key, at, expiresAt);
    return true;
  }
  async clear(key: string) { this.hits.delete(key); }
  private sweep() {
    const from = this.now() - 24 * 3_600_000;
    for (const [key, list] of this.hits) if (!list.some((at) => at > from)) this.hits.delete(key);
  }
}

/** The minimum a database store needs: raw SQL through Prisma. */
export interface SqlClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<R>(fn: (tx: Omit<SqlClient, '$transaction'>) => Promise<R>): Promise<R>;
}

/**
 * Counters in the `rate_limit_hits` table, shared by all API instances. `addIfUnder` counts and inserts in one transaction under
 * an advisory lock per key, so two instances cannot both let the last allowed attempt through.
 */
export class DatabaseRateLimitStore implements RateLimitStore {
  private writes = 0;
  constructor(private readonly db: SqlClient) {}
  async count(key: string, since: number) {
    const rows = await this.db.$queryRawUnsafe<Array<{ n: number }>>('SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = $1 AND at > $2', key, new Date(since));
    return rows[0]?.n ?? 0;
  }
  async add(key: string, at: number, expiresAt: number) {
    await this.db.$executeRawUnsafe('INSERT INTO rate_limit_hits (key, at, expires_at) VALUES ($1, $2, $3)', key, new Date(at), new Date(expiresAt));
    await this.maybeSweep();
  }
  async addIfUnder(key: string, at: number, since: number, max: number, expiresAt: number) {
    const added = await this.db.$transaction(async (tx) => {
      // One writer per key at a time: the count and the insert see the same state on every instance.
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l', key);
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>('SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = $1 AND at > $2', key, new Date(since));
      if ((rows[0]?.n ?? 0) >= max) return false;
      await tx.$executeRawUnsafe('INSERT INTO rate_limit_hits (key, at, expires_at) VALUES ($1, $2, $3)', key, new Date(at), new Date(expiresAt));
      return true;
    });
    await this.maybeSweep();
    return added;
  }
  async clear(key: string) { await this.db.$executeRawUnsafe('DELETE FROM rate_limit_hits WHERE key = $1', key); }
  private async maybeSweep() {
    if (++this.writes % 200 === 0) await this.db.$executeRawUnsafe('DELETE FROM rate_limit_hits WHERE expires_at < now()').catch(() => undefined);
  }
}

let sharedStore: RateLimitStore | null = null;
/** Called once at start-up when RATE_LIMIT_STORE=database; limiters created without their own store use it. */
export function useRateLimitStore(store: RateLimitStore | null): void { sharedStore = store; }
export function rateLimitStoreKind(env: NodeJS.ProcessEnv = process.env): 'memory' | 'database' {
  return env.RATE_LIMIT_STORE === 'database' ? 'database' : 'memory';
}

export class RateLimiter {
  private readonly ownStore: RateLimitStore | null;
  private readonly fallback: RateLimitStore;
  constructor(private readonly now: () => number = Date.now, store?: RateLimitStore) {
    this.ownStore = store ?? null;
    this.fallback = new MemoryRateLimitStore(now);
  }

  /** The store chosen at start-up, read on each call so limiters created before start-up still follow it. */
  private get store(): RateLimitStore { return this.ownStore ?? sharedStore ?? this.fallback; }

  private key(scope: string, value: string): string {
    return `${scope}:${createHash('sha256').update(value.trim().toLowerCase()).digest('base64url').slice(0, 22)}`;
  }

  /** True when another attempt is still allowed. Does not count the attempt. */
  async allowed(scope: string, value: string, limit: Limit): Promise<boolean> {
    return (await this.store.count(this.key(scope, value), this.now() - limit.windowMs)) < limit.max;
  }

  /** Counts an attempt. */
  async hit(scope: string, value: string, limit: Limit): Promise<void> {
    const at = this.now();
    await this.store.add(this.key(scope, value), at, at + limit.windowMs);
  }

  /** Counts the attempt and refuses with 429 when the limit was already reached. */
  async take(scope: string, value: string, limit: Limit, code = 'TOO_MANY_ATTEMPTS'): Promise<void> {
    const at = this.now();
    if (!(await this.store.addIfUnder(this.key(scope, value), at, at - limit.windowMs, limit.max, at + limit.windowMs))) {
      throw new HttpException(code, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async clear(scope: string, value: string): Promise<void> {
    await this.store.clear(this.key(scope, value));
  }
}

export const authLimits = {
  /** Wrong passwords for one e-mail before sign-in pauses. */
  loginFailuresPerEmail: { max: 8, windowMs: 15 * 60_000 },
  /** Sign-in attempts from one address (shared networks included), generous on purpose. */
  loginPerIp: { max: 60, windowMs: 15 * 60_000 },
  registerPerIp: { max: 10, windowMs: 60 * 60_000 },
  /** Any account mail (verification, password reset) to one address. */
  mailPerEmail: { max: 3, windowMs: 60 * 60_000 },
  mailPerIp: { max: 20, windowMs: 60 * 60_000 },
  tokenPerIp: { max: 30, windowMs: 15 * 60_000 },
  /** Started and finished sign-ins with an outside provider (Google) from one address. */
  oauthPerIp: { max: 40, windowMs: 15 * 60_000 },
} satisfies Record<string, Limit>;
