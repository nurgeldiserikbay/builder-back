import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardFor, HOSTING_SUBDOMAIN, recommend } from './cards.js';
import { launchIssues, launchItems, normalizeLaunch, type LaunchFacts } from '../journey/launch.js';
import { roadmapIssues, type Roadmap } from '../journey/roadmap.js';
import type { AppFeatures } from '../journey/webapp.js';

const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  readiness: { blocking: { total: 1, passed: 1 }, scenarios: { total: 1, works: 1 }, openRemarks: 0 },
  deployment: { url: 'https://crm.onrender.com', ok: true, database: 'postgres', checkedAt: '2026-11-26T00:00:00Z' },
  features: { sensitivity: 'normal' } as AppFeatures, idea: null, design: null, ...over,
});

describe('choice cards of a web application', () => {
  it('an application decides its technologies, hosting and address with its own options; a site keeps the site cards', () => {
    assert.deepEqual(cardFor('technologies', 'web_app').options.map((option) => option.key), ['buildpath', 'developer']);
    assert.deepEqual(cardFor('deployment', 'web_app').options.map((option) => option.key), ['render', 'own_server']);
    assert.deepEqual(cardFor('domain', 'web_app').options.map((option) => option.key), ['host_address', 'own_domain']);
    assert.ok(cardFor('deployment', 'business_card').options.some((option) => option.key === 'buildpath'), 'a site is still published on BuildPath');
    assert.ok(cardFor('code_hosting', 'web_app').options.some((option) => option.key === 'network_agent'));
    // Recommendations are what the code is ready for, and every recommended option exists.
    for (const key of ['technologies', 'deployment', 'domain', 'code_hosting'] as const) {
      const pick = recommend(key, { hasSpecialists: false, projectType: 'web_app' });
      assert.ok(cardFor(key, 'web_app').options.some((option) => option.key === pick.optionKey), key);
    }
    assert.equal(recommend('deployment', { hasSpecialists: false, projectType: 'web_app' }).optionKey, 'render');
  });

  it('the Render card says what the free plan does not give', () => {
    const render = cardFor('deployment', 'web_app').options.find((option) => option.key === 'render')!;
    assert.ok(render.limits.some((limit) => limit.includes('15 минут')));
    assert.ok(render.limits.some((limit) => limit.includes('30 дней')));
  });

  it('on the developer\'s own stack, modules given to the AI are a finding', () => {
    const plan: Roadmap = { modules: [
      { key: 'core', name: 'Основа', summary: '', contractModule: null, dependsOn: [], executor: 'ai', tasks: [] },
      { key: 'pay', name: 'Оплата', summary: '', contractModule: null, dependsOn: ['core'], executor: 'specialist', tasks: [] },
    ], risks: [], hoursPerDay: 6, notes: '' };
    assert.deepEqual(roadmapIssues(plan, null, null, 'developer').filter((issue) => issue.code === 'ROADMAP_AI_OTHER_STACK').map((issue) => issue.target), ['core']);
    assert.ok(!roadmapIssues(plan, null, null, 'buildpath').some((issue) => issue.code === 'ROADMAP_AI_OTHER_STACK'));
  });

  it('an own domain chosen: the domain item is required and the hosting\'s address does not count', () => {
    const done = normalizeLaunch({ items: ['domain', 'legal', 'email', 'backups', 'monitoring', 'migration', 'analytics', 'audit'].map((key) => ({ key, status: 'done' })) });
    assert.equal(launchItems(facts({ domainChoice: 'own_domain' })).find((item) => item.key === 'domain')!.required, true);
    assert.equal(launchItems(facts()).find((item) => item.key === 'domain')!.required, false);
    assert.ok(launchIssues(done, facts({ domainChoice: 'own_domain' })).some((issue) => issue.code === 'LAUNCH_DOMAIN_NOT_CHECKED'));
    assert.ok(!launchIssues(done, facts({ domainChoice: 'own_domain', deployment: { url: 'https://app.clean.kz', ok: true, database: 'postgres', checkedAt: '' } })).some((issue) => issue.code === 'LAUNCH_DOMAIN_NOT_CHECKED'));
    assert.ok(!launchIssues(done, facts({ domainChoice: 'host_address' })).some((issue) => issue.code === 'LAUNCH_DOMAIN_NOT_CHECKED'));
    assert.ok(HOSTING_SUBDOMAIN.test('crm.onrender.com') && !HOSTING_SUBDOMAIN.test('onrender.com.evil.kz'));
  });
});
