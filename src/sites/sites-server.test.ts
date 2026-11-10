import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createSitesServer } from './sites-server.js';

let databaseUp = true;
const fakePrisma = {
  sitePublication: {
    findUnique: async ({ where }: { where: { slug: string } }) => (where.slug === 'tort' ? { id: 'p1', projectId: 'pr1', status: 'live', buildVersionId: 'v1' } : where.slug === 'old' ? { id: 'p2', projectId: 'pr2', status: 'unpublished', buildVersionId: 'v2' } : null),
  },
  stageArtifactVersion: { findUnique: async () => ({ content: { html: '<!doctype html><title>Торт</title>', meta: null } }) },
  $queryRaw: async () => { if (!databaseUp) throw new Error('down'); return [{ '?column?': 1 }]; },
} as unknown as PrismaClient;

const server = createSitesServer(fakePrisma, {
  baseDomain: 'sites.example.kz', urlFor: (slug) => `https://${slug}.sites.example.kz`, trustProxy: true, ipSalt: 'salt', retentionDays: 365,
  https: true, perIpPerHour: 5, perSitePerDay: 200, notify: async () => undefined, notifyBooking: async () => undefined,
}).server;
let base = '';
before(async () => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(() => { server.close(); });

describe('sites server service endpoints', () => {
  it('allows TLS certificates only for live site subdomains', async () => {
    const ask = (domain: string) => fetch(`${base}/__caddy/ask?domain=${encodeURIComponent(domain)}`).then((response) => response.status);
    assert.equal(await ask('tort.sites.example.kz'), 200);
    assert.equal(await ask('old.sites.example.kz'), 404);
    assert.equal(await ask('missing.sites.example.kz'), 404);
    assert.equal(await ask('evil.example.com'), 404);
    assert.equal(await ask('a.tort.sites.example.kz'), 404);
    assert.equal(await ask(''), 404);
  });
  it('reports database health', async () => {
    assert.equal((await fetch(`${base}/__health`)).status, 200);
    databaseUp = false;
    assert.equal((await fetch(`${base}/__health`)).status, 503);
    databaseUp = true;
  });
  it('still serves sites by host', async () => {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`${base}/`, { headers: { host: 'tort.sites.example.kz' } }, (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    assert.equal(status, 200);
    assert.match(body, /Торт/);
  });
});

describe('error reporting', () => {
  it('never sends cookies, bodies, query strings or user data', async () => {
    const { scrubEvent, shouldReport } = await import('../observability/error-reporting.js');
    const { BadRequestException, InternalServerErrorException } = await import('@nestjs/common');
    const event = scrubEvent({
      request: { url: 'https://app.example.kz/api/v1/auth/login?token=secret', cookies: { session: 'x' }, data: '{"password":"p"}', query_string: 'token=secret', headers: { Cookie: 'session=x', Authorization: 'Bearer t', 'User-Agent': 'Safari' } },
      user: { email: 'a@b.kz' }, breadcrumbs: [{ message: 'x' }],
    });
    assert.deepEqual(event, { request: { url: 'https://app.example.kz/api/v1/auth/login', headers: { 'User-Agent': 'Safari' } } });
    assert.equal(shouldReport(new BadRequestException('INVALID')), false);
    assert.equal(shouldReport(new InternalServerErrorException()), true);
    assert.equal(shouldReport(new Error('boom')), true);
  });
});
