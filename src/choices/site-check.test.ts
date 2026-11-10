import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSite, compareSite } from './site-check.js';
import { choiceCards, recommend } from './cards.js';

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

describe('deployed site check', () => {
  it('compares pages ignoring whitespace, tells an older version from another site', () => {
    assert.equal(compareSite(page('Барбершоп', '<h1>Стрижки</h1>'), page('Барбершоп', '\n  <h1>Стрижки</h1>\n')), 'matches');
    assert.equal(compareSite(page('Барбершоп', '<h1>Стрижки</h1>'), page('Барбершоп', '<h1>Старые цены</h1>')), 'outdated');
    assert.equal(compareSite(page('Барбершоп', 'x'), page('Чужой сайт', 'x')), 'different');
  });
  it('follows redirects on local test addresses and reports HTTP errors', async () => {
    const expected = page('A', 'b');
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/old')) return new Response(null, { status: 301, headers: { location: '/new' } });
      if (url.endsWith('/new')) return new Response(expected, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    assert.deepEqual(await checkSite('http://localhost:1/old', expected, { allowLocal: true, fetchImpl }), { status: 'matches', finalUrl: 'http://localhost:1/new', httpStatus: 200 });
    assert.deepEqual(await checkSite('http://localhost:1/missing', expected, { allowLocal: true, fetchImpl }), { status: 'unreachable', finalUrl: 'http://localhost:1/missing', httpStatus: 404 });
  });
  it('refuses private addresses unless local testing is allowed', async () => {
    const fetchImpl = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
    assert.equal((await checkSite('http://127.0.0.1/', 'x', { allowLocal: false, fetchImpl })).status, 'not_allowed');
    assert.equal((await checkSite('http://10.0.0.5/', 'x', { allowLocal: false, fetchImpl })).status, 'not_allowed');
    assert.equal((await checkSite('ftp://example.com/', 'x', { allowLocal: false, fetchImpl })).status, 'not_allowed');
  });
});

describe('deployment card', () => {
  it('recommends BuildPath and makes GitHub Pages depend on GitHub', () => {
    assert.equal(recommend('deployment', { hasSpecialists: true }).optionKey, 'buildpath');
    const pages = choiceCards.deployment.options.find((option) => option.key === 'github_pages')!;
    assert.deepEqual(pages.requires && { card: pages.requires.card, option: pages.requires.option }, { card: 'code_hosting', option: 'github' });
    for (const option of choiceCards.deployment.options) assert.ok(option.steps.some((step) => step.kind === 'verify'), option.key);
  });
});
