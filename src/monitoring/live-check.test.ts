import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { judge, liveCheck } from './live-check.js';

const good = { status: 200, ms: 50, headers: {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=()', 'strict-transport-security': 'max-age=31536000',
} };

describe('published address check', () => {
  it('passes a site served the way the sites server serves it', () => {
    const items = judge('https://cakes.example.kz/', good, { status: 308, ms: 5, headers: { location: 'https://cakes.example.kz/' } }, { status: 200, ms: 5, headers: {} });
    assert.deepEqual(items.filter((item) => item.status === 'failed'), []);
  });

  it('names what is missing, and does not guess when the site did not answer', () => {
    const items = Object.fromEntries(judge('http://cakes.example.kz/', { status: 200, ms: 5, headers: { 'x-frame-options': 'DENY' } }, null, { status: 404, ms: 5, headers: {} }).map((item) => [item.id, item.status]));
    assert.deepEqual(items, { https: 'failed', certificate: 'failed', hsts: 'failed', http_redirect: 'failed', csp: 'failed', frame: 'passed', nosniff: 'failed', referrer: 'failed', permissions: 'failed', robots: 'failed' });
    assert.ok(judge('https://x.example/', null, null, null).every((item) => item.status === 'unknown'));
    const noRedirect = judge('https://x.example/', good, { status: 200, ms: 5, headers: {} }, null);
    assert.equal(noRedirect.find((item) => item.id === 'http_redirect')!.status, 'failed');
  });

  it('reads headers from a real server and reports an unreachable one', async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === '/robots.txt' ? 200 : 200, { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const check = await liveCheck(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, true);
      const items = Object.fromEntries(check.items.map((item) => [item.id, item.status]));
      assert.equal(check.reachable, true);
      assert.equal(items.csp, 'passed');
      assert.equal(items.nosniff, 'passed');
      assert.equal(items.https, 'failed');
      assert.equal(items.robots, 'passed');
    } finally { server.close(); }
    const down = await liveCheck('http://127.0.0.1:1/', true);
    assert.equal(down.reachable, false);
    assert.equal(down.error, 'REFUSED');
  });
});

describe('certificate and regressions', () => {
  it('reports a certificate ending within two weeks and only items that broke since last time', async () => {
    const { judge: j, regressions } = await import('./live-check.js');
    const now = new Date('2026-11-14T00:00:00Z');
    const soon = { ...good, certExpires: '2026-11-20T00:00:00Z' };
    const later = { ...good, certExpires: '2027-02-01T00:00:00Z' };
    const plain = { status: 308, ms: 1, headers: { location: 'https://a/' } };
    const robots = { status: 200, ms: 1, headers: {} };
    assert.equal(j('https://a/', soon, plain, robots, now).find((item) => item.id === 'certificate')!.status, 'failed');
    assert.equal(j('https://a/', later, plain, robots, now).find((item) => item.id === 'certificate')!.status, 'passed');
    const check = (main: typeof good) => ({ url: 'https://a/', checkedAt: '', reachable: true, error: null, ms: 1, items: j('https://a/', main, plain, robots, now) });
    assert.deepEqual(regressions(check(later), check(soon)), ['certificate']);
    assert.deepEqual(regressions(null, check(soon)), []);
    assert.deepEqual(regressions(check(soon), check(soon)), []);
  });
});
