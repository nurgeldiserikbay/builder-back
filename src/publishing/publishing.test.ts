import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadText } from '../notifications/lead-notifier.js';
import { sendTelegramMessage, telegramConfig } from '../notifications/telegram.js';
import { parseLeadForm, privacyPage } from '../sites/site-pages.js';
import { checkSite, renderSite, siteMeta } from '../journey/site-renderer.js';
import { templateContent, type Brief } from '../journey/artifacts.js';
import { sitesConfig, slugFromHost, slugProblem, suggestSlug } from './slug.js';

const brief: Brief = {
  businessName: 'Торты от Айгерим', whatYouDo: 'Торты на заказ', audience: 'Родители', city: 'Алматы',
  mainAction: 'form', phone: '+7 701 123 45 67', messenger: null, email: null, address: null, tone: 'friendly',
};
const design = { palette: 'forest', font: 'modern', corners: 'rounded' as const, heroLayout: 'centered' as const };

describe('site address', () => {
  it('validates slugs', () => {
    assert.equal(slugProblem('torty-aigerim'), null);
    assert.ok(slugProblem('ab'));
    assert.ok(slugProblem('Торты'));
    assert.ok(slugProblem('-torty'));
    assert.ok(slugProblem('a--b'));
    assert.ok(slugProblem('admin'));
  });
  it('suggests a readable latin address', () => {
    assert.equal(suggestSlug('Торты от Айгерим'), 'torty-ot-aygerim');
    assert.equal(suggestSlug('Қазақ Шай'), 'kazak-shay');
    assert.equal(slugProblem(suggestSlug('!!')), null);
  });
  it('maps only direct subdomains of the base domain', () => {
    assert.equal(slugFromHost('torty.buildpath.site', 'buildpath.site'), 'torty');
    assert.equal(slugFromHost('torty.buildpath.site:443', 'buildpath.site'), 'torty');
    assert.equal(slugFromHost('a.b.buildpath.site', 'buildpath.site'), null);
    assert.equal(slugFromHost('buildpath.site', 'buildpath.site'), null);
    assert.equal(slugFromHost('evil-buildpath.site', 'buildpath.site'), null);
    assert.equal(slugFromHost('admin.buildpath.site', 'buildpath.site'), null);
  });
  it('builds public URLs from the template', () => {
    assert.equal(sitesConfig({ SITES_BASE_DOMAIN: 'buildpath.site', SITES_PUBLIC_URL_TEMPLATE: 'https://{slug}.buildpath.site' }).urlFor('torty'), 'https://torty.buildpath.site');
  });
});

describe('lead form', () => {
  it('renders a consented form that may only post to the same origin', () => {
    const content = templateContent(brief, null);
    const html = renderSite({ brief, offer: null, content, design, locale: 'ru', draft: false });
    assert.ok(html.includes('action="/__forms/lead"'));
    assert.ok(html.includes('name="consent"'));
    assert.ok(html.includes("form-action 'self'"));
    assert.ok(html.includes('href="#request"'));
    const without = renderSite({ brief: { ...brief, mainAction: 'message', messenger: '@aigerim_cakes' }, offer: null, content, design, locale: 'ru', draft: false });
    assert.ok(without.includes("form-action 'none'"));
    assert.ok(!without.includes('<form'));
  });
  it('requires an owner contact for the privacy notice', () => {
    const content = templateContent(brief, null);
    const ok = checkSite({ brief, offer: null, content, design, locale: 'ru', draft: false });
    assert.equal(ok.find((check) => check.id === 'form-privacy')?.status, 'passed');
    const missing = checkSite({ brief: { ...brief, phone: null }, offer: null, content, design, locale: 'ru', draft: false });
    assert.equal(missing.find((check) => check.id === 'form-privacy')?.status, 'failed');
  });
  it('validates submissions and drops honeypot spam', () => {
    assert.deepEqual(parseLeadForm('name=Аня&contact=%2B77011234567&message=Торт&consent=yes'), { ok: true, lead: { name: 'Аня', contact: '+77011234567', message: 'Торт' } });
    const spam = parseLeadForm('name=Bot&contact=123456&consent=yes&website=http://spam');
    assert.equal(spam.ok, false);
    assert.equal(!spam.ok && spam.spam, true);
    const noConsent = parseLeadForm('name=Аня&contact=123456');
    assert.equal(!noConsent.ok && noConsent.spam, false);
    assert.equal(parseLeadForm(`name=${'x'.repeat(81)}&contact=123456&consent=yes`).ok, false);
  });
  it('escapes owner data on the privacy page', () => {
    const meta = siteMeta({ brief: { ...brief, businessName: '<b>X</b>' }, offer: null, content: templateContent(brief, null), design, locale: 'ru', draft: false });
    const html = privacyPage(meta, 365);
    assert.ok(html.includes('&lt;b&gt;X&lt;/b&gt;'));
    assert.ok(html.includes('+7 701 123 45 67'));
    assert.ok(html.includes('12 мес.'));
  });
});

describe('notifications', () => {
  it('formats a plain-text lead message with a link to the app', () => {
    const text = leadText({ name: 'Аня', contact: '+7701', message: null, siteName: 'Торты', projectId: 'p1' }, 'https://app.buildpath.kz');
    assert.equal(text, 'Новая заявка с сайта «Торты»\nИмя: Аня\nКонтакт: +7701\nВсе заявки: https://app.buildpath.kz/projects/p1/leads');
  });
  it('reads Telegram config and refuses insecure endpoints', () => {
    assert.equal(telegramConfig({}), null);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: '@bp_bot', TELEGRAM_API_BASE_URL: 'http://evil.example' }), null);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: '@bp_bot' })?.botUsername, 'bp_bot');
    assert.ok(telegramConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'b', TELEGRAM_API_BASE_URL: 'http://localhost:4566' }));
  });
  it('sends Telegram messages as plain text', async () => {
    let sent: Record<string, unknown> = {};
    const ok = await sendTelegramMessage({ token: 'T', botUsername: 'b', webhookSecret: null, apiBase: 'https://api.telegram.org' }, '42', '<b>hi</b>',
      (async (url: string, init: RequestInit) => { sent = { url, ...JSON.parse(String(init.body)) }; return new Response('{}'); }) as unknown as typeof fetch);
    assert.equal(ok, true);
    assert.equal(sent.url, 'https://api.telegram.org/botT/sendMessage');
    assert.equal(sent.parse_mode, undefined);
    assert.equal(sent.text, '<b>hi</b>');
  });
});
