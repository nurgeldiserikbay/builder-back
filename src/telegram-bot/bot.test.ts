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

describe('Bot language', () => {
  it('writes texts in the language it runs in', async () => {
    const { runWithLocale } = await import('../i18n/i18n.js');
    const { helpText } = await import('./bot-texts.js');
    runWithLocale('en', () => {
      assert.equal(errorText('STAGE_LOCKED'), 'The stage is still locked: the previous ones need to be accepted first.');
      assert.ok(helpText().startsWith('I help you run BuildPath projects right in Telegram.'));
      assert.ok(artifactSummary('brief', { businessName: 'Nails', whatYouDo: 'Manicure', audience: '', mainAction: 'form' }).includes('Main action: leave a request on the site'));
      assert.equal(artifactSummary('site', { checks: [] }), 'All required checks passed.');
    });
    assert.equal(errorText('STAGE_LOCKED'), 'Этап ещё закрыт: сначала нужно принять предыдущие.');
  });

  it('answers in the account language, or in the Telegram app language before linking', async () => {
    const http = await import('node:http');
    const sent: string[] = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { sent.push(JSON.parse(body || '{}').text ?? ''); response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_BOT_USERNAME: 'buildpath_bot', TELEGRAM_WEBHOOK_SECRET: 'S', TELEGRAM_API_BASE_URL: `http://127.0.0.1:${port}` });
    try {
      const { TelegramLinkService } = await import('../publishing/telegram-link.service.js');
      let linked: unknown = null;
      const prisma = { externalIdentity: { findUnique: async () => linked } };
      const service = new TelegramLinkService(prisma as never, {} as never);
      const message = (language: string) => ({ message: { text: 'hello', chat: { id: 1, type: 'private' }, from: { id: 2, language_code: language } } });
      await service.handleUpdate('S', message('en'));
      await service.handleUpdate('S', message('ru'));
      // Linked, with outdated legal consent: the reply follows the account language, not the app language.
      linked = { userId: 'u1', user: { locale: 'en', deletionRequestedAt: null, consents: [] } };
      await service.handleUpdate('S', message('ru'));
      assert.match(sent[0]!, /^This is the BuildPath bot\./);
      assert.match(sent[1]!, /^Это бот BuildPath\./);
      assert.match(sent[2]!, /^We have updated the terms/);
    } finally {
      server.close();
      for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_API_BASE_URL']) delete process.env[key];
    }
  });
  it('passes a document or the largest photo to the bot as a file, with the caption as text', async () => {
    const { TelegramLinkService } = await import('../publishing/telegram-link.service.js');
    const { LEGAL_VERSIONS } = await import('../legal/documents.js');
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_BOT_USERNAME: 'buildpath_bot', TELEGRAM_WEBHOOK_SECRET: 'S' });
    try {
      const calls: unknown[][] = [];
      const linked = { userId: 'u1', user: { locale: 'ru', deletionRequestedAt: null, consents: [{ termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy }] } };
      const prisma = { externalIdentity: { findUnique: async () => linked } };
      const bot = { onMessage: async (...args: unknown[]) => { calls.push(args); } };
      const service = new TelegramLinkService(prisma as never, bot as never);
      const base = { chat: { id: 1, type: 'private' }, from: { id: 2, language_code: 'ru' } };
      await service.handleUpdate('S', { message: { ...base, document: { file_id: 'D1', file_name: 'ТЗ.pdf', file_size: 1200 }, caption: 'Вот ТЗ' } });
      await service.handleUpdate('S', { message: { ...base, photo: [{ file_id: 'small', width: 90, file_size: 900 }, { file_id: 'big', width: 1280, file_size: 90000 }] } });
      await service.handleUpdate('S', { message: { ...base, sticker: { file_id: 'S1' } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(calls.map((call) => call.slice(2)), [
        ['Вот ТЗ', 'file', { fileId: 'D1', name: 'ТЗ.pdf', size: 1200 }],
        [null, 'file', { fileId: 'big', name: 'photo.jpg', size: 90000 }],
        [null, 'other', undefined],
      ]);
    } finally {
      for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET']) delete process.env[key];
    }
  });
});
