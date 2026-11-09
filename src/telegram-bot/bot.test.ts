import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyWebAppInitData } from '../notifications/telegram.js';
import { artifactSummary, errorText } from './bot-texts.js';

function signedInitData(token: string, fields: Record<string, string>): string {
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('Telegram Mini App initData', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const fields = { auth_date: String(Math.floor(now / 1000) - 60), query_id: 'AAE', user: JSON.stringify({ id: 555, first_name: 'Айгерим' }) };
  it('accepts correctly signed fresh data', () => {
    assert.deepEqual(verifyWebAppInitData(signedInitData('T123', fields), 'T123', 86_400, now), { telegramUserId: '555' });
  });
  it('rejects a wrong bot token, tampering and stale data', () => {
    assert.equal(verifyWebAppInitData(signedInitData('OTHER', fields), 'T123', 86_400, now), null);
    const tampered = signedInitData('T123', fields).replace('555', '556');
    assert.equal(verifyWebAppInitData(tampered, 'T123', 86_400, now), null);
    const stale = signedInitData('T123', { ...fields, auth_date: String(Math.floor(now / 1000) - 90_000) });
    assert.equal(verifyWebAppInitData(stale, 'T123', 86_400, now), null);
    assert.equal(verifyWebAppInitData('user=1', 'T123', 86_400, now), null);
  });
});

describe('bot texts', () => {
  it('summarizes stage results for chat', () => {
    assert.equal(artifactSummary('offer', { services: [{ name: 'Маникюр', price: '8 000 ₸', description: null }], hours: null }), '• Маникюр — 8 000 ₸');
    assert.ok(artifactSummary('brief', { businessName: 'Ногти', whatYouDo: 'Маникюр', audience: '', mainAction: 'form' }).includes('оставить заявку на сайте'));
    assert.equal(artifactSummary('site', { checks: [{ status: 'passed', required: true, title: 'A' }] }), 'Все обязательные проверки пройдены.');
  });
  it('explains errors without technical codes', () => {
    assert.ok(!errorText('AI_BUDGET_EXHAUSTED').includes('_'));
    assert.ok(errorText('STAGE_INCOMPLETE:phone').includes('не до конца'));
    assert.ok(!errorText('SOMETHING_ELSE').includes('SOMETHING'));
  });
});
