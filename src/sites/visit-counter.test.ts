import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VisitCounter, countable, dayIn, sourceOf } from './visit-counter.js';

const browser = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

describe('page view counter', () => {
  it('counts people opening a page, not robots, link previews or prefetches', () => {
    assert.equal(countable({ method: 'GET', headers: { 'user-agent': browser } }), true);
    assert.equal(countable({ method: 'HEAD', headers: { 'user-agent': browser } }), false);
    assert.equal(countable({ method: 'GET', headers: {} }), false);
    assert.equal(countable({ method: 'GET', headers: { 'user-agent': 'Googlebot/2.1' } }), false);
    assert.equal(countable({ method: 'GET', headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } }), false);
    assert.equal(countable({ method: 'GET', headers: { 'user-agent': 'WhatsApp/2.23' } }), false);
    assert.equal(countable({ method: 'GET', headers: { 'user-agent': browser, 'sec-purpose': 'prefetch;prerender' } }), false);
  });
  it('keeps only the host of the referring site, never the full address', () => {
    assert.equal(sourceOf('https://www.google.com/search?q=торты+алматы', ['tort.buildpath.kz']), 'google.com');
    assert.equal(sourceOf('https://tort.buildpath.kz/services', ['tort.buildpath.kz']), 'direct');
    assert.equal(sourceOf(undefined, []), 'direct');
    assert.equal(sourceOf('not a url', []), 'direct');
  });
  it('counts by day in the site owners time zone', () => {
    assert.equal(dayIn('Asia/Almaty', new Date('2026-11-12T20:30:00Z')), '2026-11-13');
    assert.equal(dayIn('UTC', new Date('2026-11-12T20:30:00Z')), '2026-11-12');
  });
  it('adds up views in memory, writes them in one go and keeps them on a failure', async () => {
    const written: unknown[][] = [];
    let fail = true;
    const prisma = { $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => { if (fail) throw new Error('connection lost'); written.push(values); return 1; } };
    const counter = new VisitCounter(prisma as never, 'UTC');
    const now = new Date('2026-11-12T10:00:00Z');
    counter.add('p1', '/', 'direct', now); counter.add('p1', '/', 'direct', now); counter.add('p1', '/services', 'google.com', now);
    assert.equal(counter.size, 2);
    assert.equal(await counter.flush(), 0);
    assert.equal(counter.size, 2); // kept for the next try
    fail = false;
    assert.equal(await counter.flush(), 3);
    assert.equal(counter.size, 0);
    assert.deepEqual(written.find((values) => values[2] === '/'), ['p1', '2026-11-12', '/', 'direct', 2]);
  });
});
