// In-memory sliding-window limits for account endpoints (sign-in, registration, recovery mail).
// One API process keeps its own counters; with several API instances each one limits separately, which still bounds
// abuse. Keys are hashed so e-mail addresses do not sit in memory in clear text.
import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';

export interface Limit { max: number; windowMs: number }

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweeps = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private key(scope: string, value: string): string {
    return `${scope}:${createHash('sha256').update(value.trim().toLowerCase()).digest('base64url').slice(0, 22)}`;
  }

  private recent(key: string, windowMs: number): number[] {
    const from = this.now() - windowMs;
    const list = (this.hits.get(key) ?? []).filter((at) => at > from);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** True when another attempt is still allowed. Does not count the attempt. */
  allowed(scope: string, value: string, limit: Limit): boolean {
    return this.recent(this.key(scope, value), limit.windowMs).length < limit.max;
  }

  /** Counts an attempt. */
  hit(scope: string, value: string, limit: Limit): void {
    const key = this.key(scope, value);
    const list = this.recent(key, limit.windowMs);
    list.push(this.now());
    this.hits.set(key, list);
    if (++this.sweeps % 500 === 0) this.sweep();
  }

  /** Counts the attempt and refuses with 429 when the limit was already reached. */
  take(scope: string, value: string, limit: Limit, code = 'TOO_MANY_ATTEMPTS'): void {
    if (!this.allowed(scope, value, limit)) throw new HttpException(code, HttpStatus.TOO_MANY_REQUESTS);
    this.hit(scope, value, limit);
  }

  clear(scope: string, value: string): void {
    this.hits.delete(this.key(scope, value));
  }

  private sweep(): void {
    const from = this.now() - 24 * 3_600_000;
    for (const [key, list] of this.hits) if (!list.some((at) => at > from)) this.hits.delete(key);
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
} satisfies Record<string, Limit>;
