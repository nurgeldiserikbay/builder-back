import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedOrigins, originRefusal } from './origin-check.js';

const allowed = allowedOrigins({ CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001', PUBLIC_APP_URL: 'https://buildpath.kz', ADMIN_PUBLIC_URL: '' } as NodeJS.ProcessEnv);
const post = (headers: Record<string, string>, extra: Partial<Parameters<typeof originRefusal>[0]> = {}) =>
  originRefusal({ method: 'POST', path: '/api/v1/projects/x/stages/goal/accept', headers, host: 'buildpath.kz', protocol: 'https', ...extra }, allowed);

test('state-changing requests must come from an allowed origin', () => {
  assert.equal(post({ origin: 'https://buildpath.kz' }), null);
  assert.equal(post({ origin: 'http://localhost:3000' }), null);
  // A published customer site is same-site with the platform: refused.
  assert.equal(post({ origin: 'https://shop.sites.buildpath.kz' }), 'ORIGIN_NOT_ALLOWED');
  assert.equal(post({ origin: 'https://evil.example' }), 'ORIGIN_NOT_ALLOWED');
  assert.equal(post({ origin: 'null' }), 'ORIGIN_NOT_ALLOWED');
  // The admin console on its own host calls the API through that host.
  assert.equal(post({ origin: 'https://admin.buildpath.kz' }, { host: 'admin.buildpath.kz' }), null);
  // No Origin: decided by Sec-Fetch-Site; nothing at all means not a browser page.
  assert.equal(post({ 'sec-fetch-site': 'same-site' }), 'ORIGIN_NOT_ALLOWED');
  assert.equal(post({ 'sec-fetch-site': 'cross-site' }), 'ORIGIN_NOT_ALLOWED');
  assert.equal(post({ 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(post({}), null);
});

test('reads and signed server callbacks are not checked', () => {
  assert.equal(originRefusal({ method: 'GET', path: '/api/v1/me', headers: { origin: 'https://evil.example' } }, allowed), null);
  assert.equal(originRefusal({ method: 'POST', path: '/api/v1/telegram/webhook', headers: { origin: 'https://evil.example' } }, allowed), null);
  assert.equal(originRefusal({ method: 'POST', path: '/api/v1/payments/freedompay/result', headers: { 'sec-fetch-site': 'cross-site' } }, allowed), null);
});
