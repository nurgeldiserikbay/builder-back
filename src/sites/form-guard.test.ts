import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createSitesServer } from './sites-server.js';
import { ANSWER_FIELD, checkGuard, guardFields, guardHtml, issueToken, TOKEN_FIELD } from './form-guard.js';
import { renderSite } from '../journey/site-renderer.js';
import { templateContent, type Brief } from '../journey/artifacts.js';

const options = { secret: 's3cret', siteId: 'pub-1', question: false };
const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe('form guard (spam protection without scripts)', () => {
  it('accepts a token older than a few seconds and refuses fast, forged, foreign and stale ones', () => {
    const now = Date.now();
    const token = issueToken({ ...options, now: now - 10_000 });
    assert.deepEqual(checkGuard(form({ [TOKEN_FIELD]: token }), { ...options, now }), { ok: true });
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: issueToken({ ...options, now }) }), { ...options, now }) as { reason: string }).reason, 'spam');
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: `${token}x` }), { ...options, now }) as { reason: string }).reason, 'expired');
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: token }), { ...options, siteId: 'pub-2', now }) as { reason: string }).reason, 'expired');
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: token }), { ...options, now: now + 25 * 3_600_000 }) as { reason: string }).reason, 'expired');
    // A form without a token: fine only for pages built before the guard.
    assert.deepEqual(checkGuard(form({}), { ...options, required: false }), { ok: true });
    assert.equal((checkGuard(form({}), { ...options, required: true }) as { reason: string }).reason, 'expired');
  });

  it('with the question on, the answer must be right and the numbers cannot be swapped', () => {
    const now = Date.now();
    const asked = { ...options, question: true };
    const html = guardHtml(`<form>${guardFields()}<button>Go</button></form>`, { ...asked, now: now - 10_000 });
    const token = /name="_g" value="([^"]+)"/.exec(html)![1]!;
    const [a, b] = /сколько будет (\d+) \+ (\d+)/.exec(html)!.slice(1).map(Number);
    assert.deepEqual(checkGuard(form({ [TOKEN_FIELD]: token, [ANSWER_FIELD]: String(a! + b!) }), { ...asked, now }), { ok: true });
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: token, [ANSWER_FIELD]: String(a! + b! + 1) }), { ...asked, now }) as { reason: string }).reason, 'answer');
    const forged = token.replace(/\.\d+-\d+\./, '.1-1.');
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: forged, [ANSWER_FIELD]: '2' }), { ...asked, now }) as { reason: string }).reason, 'expired');
    // The owner turned the question on after the page was opened: reload.
    assert.equal((checkGuard(form({ [TOKEN_FIELD]: issueToken({ ...options, now: now - 10_000 }) }), { ...asked, now }) as { reason: string }).reason, 'expired');
    // Pages without placeholders pass through untouched.
    assert.equal(guardHtml('<p>no form</p>', asked), '<p>no form</p>');
  });

  it('the generated lead form carries the token field and no visible question unless asked', () => {
    const brief: Brief = { businessName: 'Торты', whatYouDo: 'Торты на заказ', audience: 'Все', city: null, mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };
    const html = renderSite({ brief, offer: null, content: templateContent(brief, null), design: { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' }, locale: 'ru', draft: false });
    assert.match(guardHtml(html, options), /name="_g" value="\d+\.\.[A-Za-z0-9_-]{32}"/);
    assert.doesNotMatch(guardHtml(html, options), /сколько будет/);
    assert.match(guardHtml(html, { ...options, question: true }), /сколько будет \d+ \+ \d+\?<input name="_q"/);
  });
});

describe('form guard on the sites server', () => {
  const leads: string[] = [];
  const html = `<!doctype html><title>T</title><form method="post" action="/__forms/lead">${guardFields()}</form>`;
  const prisma = {
    sitePublication: { findUnique: async () => ({ id: 'pub-1', projectId: 'pr1', status: 'live', buildVersionId: 'v1', slug: 'tort', customDomain: null, domainStatus: null, formQuestion: false }) },
    stageArtifactVersion: { findUnique: async () => ({ content: { html, meta: { hasForm: true, businessName: 'T', locale: 'ru', theme: {}, ownerContacts: [] } } }) },
    siteLead: { count: async () => 0, create: async ({ data }: { data: { name: string } }) => { leads.push(data.name); return { id: 'l1' }; } },
  } as unknown as PrismaClient;
  const server = createSitesServer(prisma, {
    baseDomain: 'sites.example.kz', urlFor: (slug) => `https://${slug}.sites.example.kz`, trustProxy: true, ipSalt: 'salt', formSecret: 'secret', remindersByEmail: false, retentionDays: 365,
    https: true, perIpPerHour: 5, perSitePerDay: 200, notify: async () => undefined, notifyBooking: async () => undefined,
  }).server;
  let port = 0;
  before(async () => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as AddressInfo).port; });
  after(() => { server.close(); });
  const request = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: 'tort.sites.example.kz', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, (response) => {
      let text = '';
      response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body: text, headers: response.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });

  it('serves the page with a fresh token, drops instant sends and accepts a person', async () => {
    const page = await request('GET', '/');
    const token = /name="_g" value="([^"]+)"/.exec(page.body)![1]!;
    assert.equal(page.headers['cache-control'], 'private, max-age=60');
    const fields = 'name=Aigerim&contact=%2B77010000000&consent=yes';
    const instant = await request('POST', '/__forms/lead', `${fields}&_g=${encodeURIComponent(token)}`);
    assert.equal(instant.status, 303);
    assert.equal(leads.length, 0, 'a form sent within seconds is answered like a success but not saved');
    const missing = await request('POST', '/__forms/lead', fields);
    assert.equal(missing.status, 400);
    const older = issueToken({ secret: 'secret', siteId: 'pub-1', question: false, now: Date.now() - 20_000 });
    const person = await request('POST', '/__forms/lead', `${fields}&_g=${encodeURIComponent(older)}`);
    assert.equal(person.status, 303);
    assert.deepEqual(leads, ['Aigerim']);
  });
});
