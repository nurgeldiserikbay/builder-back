import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emailConfig, parseFrom, sendEmail } from './email.js';

describe('email provider', () => {
  it('needs a sender and a key', () => {
    assert.equal(emailConfig({}), null);
    assert.equal(emailConfig({ RESEND_API_KEY: 'r' }), null);
    assert.equal(emailConfig({ EMAIL_FROM: 'a@b.kz' }), null);
  });

  it('prefers Brevo when its key is set', () => {
    assert.deepEqual(emailConfig({ EMAIL_FROM: 'a@b.kz', RESEND_API_KEY: 'r' }), { provider: 'resend', apiKey: 'r', from: 'a@b.kz' });
    assert.deepEqual(emailConfig({ EMAIL_FROM: 'a@b.kz', RESEND_API_KEY: 'r', BREVO_API_KEY: 'b' }), { provider: 'brevo', apiKey: 'b', from: 'a@b.kz' });
  });

  it('splits the sender', () => {
    assert.deepEqual(parseFrom('BuildPath <noreply@buildpath.kz>'), { name: 'BuildPath', email: 'noreply@buildpath.kz' });
    assert.deepEqual(parseFrom('"Build Path" <x@y.com>'), { name: 'Build Path', email: 'x@y.com' });
    assert.deepEqual(parseFrom('x@y.com'), { email: 'x@y.com' });
  });

  it('sends through Brevo in its format', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const ok = await sendEmail({ provider: 'brevo', apiKey: 'key', from: 'BuildPath <me@gmail.com>' }, 'to@x.kz', 'Hi', '<p>x</p>', fake);
    assert.equal(ok, true);
    assert.equal(seen?.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal((seen?.init.headers as Record<string, string>)['api-key'], 'key');
    assert.deepEqual(JSON.parse(String(seen?.init.body)), {
      sender: { name: 'BuildPath', email: 'me@gmail.com' },
      to: [{ email: 'to@x.kz' }],
      subject: 'Hi',
      htmlContent: '<p>x</p>',
    });
  });

  it('sends through Resend in its format and reports a refusal', async () => {
    let body: unknown;
    const fake = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('{}', { status: 403 });
    }) as unknown as typeof fetch;
    const ok = await sendEmail({ provider: 'resend', apiKey: 'key', from: 'a@b.kz' }, 'to@x.kz', 'Hi', '<p>x</p>', fake);
    assert.equal(ok, false);
    assert.deepEqual(body, { from: 'a@b.kz', to: ['to@x.kz'], subject: 'Hi', html: '<p>x</p>' });
  });
});
