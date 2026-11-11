import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSite, compareSite } from './site-check.js';
import { choiceCards, recommend, technologiesCard } from './cards.js';

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

describe('Domain card', () => {
  it('starts with the free address and connects an own domain only for sites on BuildPath', () => {
    assert.equal(recommend('domain', { hasSpecialists: true }).optionKey, 'buildpath_address');
    const own = choiceCards.domain.options.find((option) => option.key === 'own_domain')!;
    assert.deepEqual([own.requires?.card, own.requires?.option], ['deployment', 'buildpath']);
    assert.ok(own.steps.some((step) => step.kind === 'domain'));
    assert.ok(own.limits.some((line) => line.includes('.kz')), 'explains the Kazakhstan hosting rule');
  });
});

describe('Technologies card', () => {
  it('recommends what BuildPath generates and is honest about other stacks', () => {
    assert.equal(recommend('technologies', { hasSpecialists: true }).optionKey, 'buildpath');
    const keys = choiceCards.technologies.options.map((option) => option.key);
    assert.deepEqual(keys, ['buildpath', 'developer', 'constructor']);
    const developer = choiceCards.technologies.options.find((option) => option.key === 'developer')!;
    assert.ok(developer.limits.some((line) => line.includes('не пишет код')));
  });
  it('describes the booking app for booking projects', () => {
    const booking = technologiesCard('booking').options.find((option) => option.key === 'buildpath')!;
    assert.match(booking.summary, /Node\.js/);
    assert.doesNotMatch(technologiesCard('landing').options[0]!.summary, /Node\.js/);
    assert.equal(choiceCards.technologies.options[0]!.summary.includes('Node.js'), false, 'base card is not changed');
  });
});
