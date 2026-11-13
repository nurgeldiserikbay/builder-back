import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browserFlags, imageIds, runBrowserCheck, serveBuild, summarizeLhr, BrowserCheckError } from './browser-check.js';

const page = (title: string, extra = '') => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="Торты на заказ в Алматы"></head><body><main><h1>${title}</h1><p>Печём торты на заказ.</p>${extra}<a href="/">Главная</a></main></body></html>`;

describe('browser check', () => {
  it('keeps scores, lab metrics and failing audits of a Lighthouse report', () => {
    const lhr = {
      lighthouseVersion: '13.6.0',
      categories: {
        performance: { score: 0.97, auditRefs: [{ id: 'largest-contentful-paint', weight: 25 }] },
        accessibility: { score: 0.8, auditRefs: [{ id: 'image-alt', weight: 10 }, { id: 'color-contrast', weight: 7 }, { id: 'skip', weight: 0 }] },
        'best-practices': { score: null, auditRefs: [] },
        seo: { score: 1, auditRefs: [{ id: 'document-title', weight: 1 }] },
      },
      audits: {
        'largest-contentful-paint': { title: 'LCP', score: 0.95, scoreDisplayMode: 'numeric', numericValue: 1234.4 },
        'cumulative-layout-shift': { title: 'CLS', score: 1, scoreDisplayMode: 'numeric', numericValue: 0.01234 },
        'image-alt': { title: 'Images need alt', score: 0, scoreDisplayMode: 'binary' },
        'color-contrast': { title: 'Contrast', score: 1, scoreDisplayMode: 'binary' },
        skip: { title: 'Not weighted', score: 0, scoreDisplayMode: 'binary' },
        'document-title': { title: 'Title', score: 1, scoreDisplayMode: 'binary' },
      },
    };
    const summary = summarizeLhr('/', lhr);
    assert.deepEqual(summary.scores, { performance: 97, accessibility: 80, 'best-practices': null, seo: 100 });
    assert.equal(summary.metrics.lcpMs, 1234);
    assert.equal(summary.metrics.cls, 0.012);
    assert.equal(summary.metrics.tbtMs, null);
    assert.deepEqual(summary.issues.map((issue) => issue.id), ['image-alt']);
  });

  it('blocks every host but the local copy and serves only pages, robots and shown photos', async () => {
    const flags = browserFlags(false);
    assert.ok(flags.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'));
    assert.ok(flags.some((flag) => flag.startsWith('--proxy-server=')));
    assert.ok(!flags.includes('--no-sandbox'));
    assert.ok(browserFlags(true).includes('--no-sandbox'));
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.deepEqual(imageIds([{ html: `<img src="/img/${id.toUpperCase()}.webp">` }]), [id]);
    const { server, origin } = await serveBuild([{ path: '/', html: page('Главная') }], new Map([[id, Buffer.from('RIFF')]]));
    try {
      const home = await fetch(`${origin}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-security-policy') ?? '', /default-src/);
      assert.equal((await fetch(`${origin}/img/${id}.webp`)).status, 200);
      assert.equal((await fetch(`${origin}/img/11111111-1111-4111-8111-111111111111.webp`)).status, 404);
      assert.equal((await fetch(`${origin}/../etc/passwd`)).status, 404);
      assert.match(await (await fetch(`${origin}/robots.txt`)).text(), /User-agent/);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('says plainly when no browser is configured', async () => {
    await assert.rejects(runBrowserCheck({ pages: [{ path: '/', html: page('x') }], images: new Map(), locale: 'ru' }, {}), (error: unknown) => error instanceof BrowserCheckError && error.code === 'BROWSER_NOT_CONFIGURED');
  });

  // Real Chromium + Lighthouse; runs where CAPTURE_CHROMIUM_EXECUTABLE_PATH points to a browser.
  it('measures a built page in a real browser without reaching the internet', { skip: process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ? false : 'no browser configured', timeout: 120_000 }, async () => {
    const result = await runBrowserCheck({ pages: [{ path: '/', html: page('Торты', '<img src="https://example.com/x.png" alt="Торт" width="10" height="10">') }], images: new Map(), locale: 'ru' });
    const [home] = result.pages;
    assert.equal(home.error, null);
    for (const value of Object.values(home.scores)) assert.ok(typeof value === 'number' && value >= 0 && value <= 100);
    assert.ok(home.metrics.fcpMs !== null && home.metrics.lcpMs !== null);
    assert.match(result.tool.lighthouse, /^\d+\.\d+\.\d+$/);
    // The outside image was not loaded: the browser logs a network error.
    assert.ok(home.issues.some((issue) => issue.id === 'errors-in-console'));
  });
});
