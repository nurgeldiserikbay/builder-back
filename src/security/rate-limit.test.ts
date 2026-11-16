import 'dotenv/config';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { DatabaseRateLimitStore, MemoryRateLimitStore, RateLimiter, rateLimitStoreKind, type SqlClient } from './rate-limit.js';
import { PrismaService } from '../database/prisma.service.js';

describe('rate limiter', () => {
  it('allows up to the limit within the window, then refuses', async () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, new MemoryRateLimitStore(() => now));
    const limit = { max: 2, windowMs: 1000 };
    await limiter.take('login', 'A@x.kz', limit);
    await limiter.take('login', 'a@x.kz ', limit); // same key after trim and lower case
    await assert.rejects(limiter.take('login', 'a@x.kz', limit), (error: { getStatus(): number }) => error.getStatus() === 429);
    now = 1001;
    await limiter.take('login', 'a@x.kz', limit);
  });

  it('keeps scopes and values apart and can be cleared', async () => {
    const limiter = new RateLimiter(() => 0, new MemoryRateLimitStore(() => 0));
    const limit = { max: 1, windowMs: 1000 };
    await limiter.hit('fail', 'a', limit);
    assert.equal(await limiter.allowed('fail', 'a', limit), false);
    assert.equal(await limiter.allowed('fail', 'b', limit), true);
    assert.equal(await limiter.allowed('other', 'a', limit), true);
    await limiter.clear('fail', 'a');
    assert.equal(await limiter.allowed('fail', 'a', limit), true);
  });

  it('uses memory unless the database store is chosen', () => {
    assert.equal(rateLimitStoreKind({} as NodeJS.ProcessEnv), 'memory');
    assert.equal(rateLimitStoreKind({ RATE_LIMIT_STORE: 'database' } as NodeJS.ProcessEnv), 'database');
  });
});

/** Shared counters in PostgreSQL — against DATABASE_URL; skipped without it. */
describe('rate limiter on the database', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM rate_limit_hits LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const scope = `test-${Date.now()}`;
  after(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DELETE FROM rate_limit_hits WHERE key LIKE '${scope}%'`);
    await prisma.$disconnect();
  });

  it('two API instances share one limit, even when they ask at the same moment', { skip }, async () => {
    const limit = { max: 5, windowMs: 60_000 };
    // Two limiters as two API processes, each with its own store object over the same table.
    const first = new RateLimiter(Date.now, new DatabaseRateLimitStore(prisma as unknown as SqlClient));
    const second = new RateLimiter(Date.now, new DatabaseRateLimitStore(prisma as unknown as SqlClient));
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).take(scope, 'same@x.kz', limit)));
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 5);
    assert.equal(await first.allowed(scope, 'same@x.kz', limit), false);
    assert.equal(await second.allowed(scope, 'other@x.kz', limit), true);
    // Keys are hashes: the address itself is not stored.
    const stored = await prisma!.$queryRawUnsafe<Array<{ key: string }>>(`SELECT key FROM rate_limit_hits WHERE key LIKE '${scope}%' `);
    assert.equal(stored.length, 5);
    for (const row of stored) assert.ok(!row.key.includes('x.kz'));
    await second.clear(scope, 'same@x.kz');
    assert.equal(await first.allowed(scope, 'same@x.kz', limit), true);
  });
});
