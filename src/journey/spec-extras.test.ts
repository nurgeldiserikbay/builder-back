import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateProcess } from './process.js';
import { normalizeSuggestions } from './suggestions.js';
import { reviewStage } from './stage-review.js';
import { stageOutputs } from './stage-outputs.js';
import { outputSchema } from './stage-ai.js';
import { normalizeFeatures, specMarkdown, templateFeatures } from './webapp.js';
import { coverage, productSteps } from './spec-extras.js';

const process = () => templateProcess('booking', null);
const codes = (value: unknown, projectType = 'booking') => reviewStage('features', value, { process: process(), projectType }).findings.map((finding) => finding.code);

test('the draft traces every step the product takes, with a story and a case per scenario', () => {
  const spec = templateFeatures(null, process(), 'site');
  const steps = productSteps(process());
  assert.ok(steps.length > 0);
  assert.ok(coverage(process(), spec.features).every((step) => step.by.length > 0));
  // Steps done by hand outside the product are not something the ТЗ must cover.
  assert.ok(!steps.some((step) => process().scenarios.some((scenario) => scenario.steps.some((item) => `step:${scenario.key}.${item.key}` === step.ref && item.capability === 'offline'))));
  const booking = spec.features.find((feature) => feature.sources.some((source) => source.startsWith('step:')))!;
  assert.match(booking.story, /^Как /);
  assert.equal(booking.cases.length, 1);
  assert.match(booking.cases[0]!.when, /→/);
  assert.deepEqual(spec.features.find((feature) => feature.key === 'privacy')!.sources, ['rule:privacy']);
  const review = codes(spec);
  assert.ok(!review.includes('SPEC_STEP_NOT_COVERED'));
  assert.ok(!review.includes('SPEC_NOT_TRACED'));
  assert.ok(!review.includes('SPEC_CLIENT_SEES_ALL'));
});

test('access by kind of participant: clients only their own, the business everything; visitors of a site only create', () => {
  const site = templateFeatures(null, process(), 'site');
  const client = process().actors.find((actor) => actor.kind === 'client')!.key;
  const business = process().actors.find((actor) => actor.kind === 'business')!.key;
  for (const row of site.access.filter((item) => item.role === client)) assert.deepEqual([row.actions, row.scope], [['create'], 'own']);
  assert.ok(site.access.some((row) => row.role === business && row.scope === 'all' && row.actions.includes('delete')));
  const app = templateFeatures(null, process(), 'app');
  assert.ok(app.access.some((row) => row.role === client && row.data === 'user' && row.actions.includes('delete') && row.scope === 'own'));
  // A client seeing everyone's records with personal data is a security finding.
  const leak = { ...site, access: site.access.map((row) => row.role === client ? { ...row, actions: ['view'], scope: 'all' } : row) };
  assert.ok(codes(normalizeFeatures(leak)).includes('SPEC_CLIENT_SEES_ALL'));
  // Rows about roles or data that no longer exist are dropped.
  assert.equal(normalizeFeatures({ ...site, access: [{ role: 'ghost', data: 'x', actions: ['view'], scope: 'all' }] }).access.length, 0);
});

test('services: account items the owner chose, payment when the process takes it; old integrations become services', () => {
  const suggestions = normalizeSuggestions({ items: [
    { key: 'reminders', catalogKey: 'reminders', title: 'Напоминание клиенту о записи', value: 'Меньше неявок.', support: 'account', decision: 'now' },
    { key: 'faq', catalogKey: 'faq', title: 'Ответы на частые вопросы', support: 'site', decision: 'now' },
  ] });
  const spec = templateFeatures(null, process(), 'site', suggestions);
  assert.deepEqual(spec.services.map((service) => [service.name, service.accessBy]), [['Напоминание клиенту о записи', 'owner']]);
  assert.deepEqual(spec.integrations, ['Напоминание клиенту о записи']);
  assert.ok(spec.features.some((feature) => feature.sources.includes('suggestion:reminders')));
  const legacy = normalizeFeatures({ roles: [], features: [], integrations: ['Kaspi Pay', 'WhatsApp'] });
  assert.deepEqual(legacy.services.map((service) => service.name), ['Kaspi Pay', 'WhatsApp']);
  assert.deepEqual(legacy.integrations, ['Kaspi Pay', 'WhatsApp']);
  assert.equal(legacy.quality.speed, '');
});

test('an old ТЗ without tracing gets one finding, not one per step; a gap in coverage is named', () => {
  const spec = templateFeatures(null, process(), 'site');
  const old = normalizeFeatures({ ...spec, features: spec.features.map((feature) => ({ ...feature, sources: [], cases: [], story: '' })) });
  const review = codes(old);
  assert.equal(review.filter((code) => code === 'SPEC_NOT_TRACED').length, 1);
  assert.ok(!review.includes('SPEC_STEP_NOT_COVERED'));
  assert.ok(review.includes('SPEC_MUST_NO_CASES'));
  const gap = normalizeFeatures({ ...spec, features: spec.features.map((feature, index) => index === 1 ? { ...feature, sources: [] } : feature) });
  const missing = reviewStage('features', gap, { process: process(), projectType: 'booking' }).findings.filter((finding) => finding.code === 'SPEC_STEP_NOT_COVERED');
  assert.ok(missing.length > 0);
  assert.match(missing[0]!.message, /ни одна функция ТЗ его не описывает/);
  // Sources other than the known kinds are dropped.
  assert.deepEqual(normalizeFeatures({ ...spec, features: [{ ...spec.features[0]!, sources: ['owner', 'javascript:x', 'step:a.b'] }] }).features[0]!.sources, ['owner', 'step:a.b']);
});

test('the document has stories, cases, sources, access, non-functional requirements, services and coverage', () => {
  const spec = normalizeFeatures({ ...templateFeatures(null, process(), 'site'), quality: { speed: 'Страница открывается за 3 секунды', users: '50 одновременно', backups: 'Каждый день' } });
  const markdown = specMarkdown({ brief: null, process: process(), features: spec, locale: 'ru' });
  for (const part of ['_Как ', 'Проверки:', 'Дано:', 'Откуда: Сценарий «', '## Кто что может', '| только свои |', '## Нефункциональные требования', '**Скорость**: Страница открывается за 3 секунды', '## Покрытие процесса', '- [x] Сценарий «']) {
    assert.ok(markdown.includes(part), part);
  }
  const outputs = stageOutputs('features', spec);
  assert.equal(outputs.find((item) => item.key === 'quality')!.met, false);
  assert.equal(outputs.find((item) => item.key === 'access')!.met, true);
  const schema = JSON.stringify(outputSchema('features', false));
  for (const field of ['"access"', '"quality"', '"services"', '"cases"', '"sources"', '"story"']) assert.ok(schema.includes(field), field);
});
