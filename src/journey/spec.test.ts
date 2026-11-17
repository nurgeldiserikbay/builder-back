import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Brief } from './artifacts.js';
import { normalizeProcess, templateProcess } from './process.js';
import { reviewStage } from './stage-review.js';
import { buildTechPlan } from './techplan.js';
import { FIRST_VERSION_SOFT_LIMIT, normalizeFeatures, specMarkdown, templateFeatures, type AppFeatures } from './webapp.js';

const brief: Brief = { businessName: 'Барбершоп Усы', whatYouDo: 'Мужские стрижки и бритьё', audience: 'Мужчины в центре города', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@usy', email: null, address: null, tone: 'friendly' };
const process = templateProcess('booking', brief);
const codes = (value: AppFeatures, type = 'booking') => reviewStage('features', value, { process, projectType: type }).findings.map((finding) => finding.code);

describe('ТЗ stage', () => {
  it('a website ТЗ without AI has no sign-in, asks consent in the form and passes the review without blockers', () => {
    const spec = templateFeatures(brief, process, 'site');
    assert.ok(!spec.features.some((feature) => feature.key === 'signin'));
    assert.ok(spec.features.some((feature) => feature.key === 'privacy' && feature.priority === 'must'));
    assert.match(spec.summary, /Барбершоп Усы/);
    assert.ok(spec.requirements.length > 0);
    assert.deepEqual(reviewStage('features', spec, { process, projectType: 'booking' }).findings.filter((finding) => finding.severity === 'blocking'), []);
    assert.ok(templateFeatures(brief, process, 'app').features.some((feature) => feature.key === 'signin'));
  });

  it('decisions put off in «Вы это учли?» become open questions the owner decides', () => {
    const later = normalizeProcess({ ...process, situations: [{ key: 'no_show', answer: 'later' }] });
    const spec = templateFeatures(brief, later, 'site');
    assert.deepEqual(spec.questions, ['Клиент записался и не пришёл. Что делаете?']);
    const findings = reviewStage('features', spec, { process: later, projectType: 'booking' }).findings.filter((finding) => finding.code === 'SPEC_OPEN_QUESTION');
    assert.equal(findings.length, 1);
    assert.ok(findings[0]!.ownerDecides && findings[0]!.severity === 'minor');
  });

  it('a big first version gets a warning, not a block', () => {
    const spec = templateFeatures(brief, process, 'site');
    const many = { ...spec, features: Array.from({ length: FIRST_VERSION_SOFT_LIMIT.site + 1 }, (_, index) => ({ ...spec.features[0]!, key: `f${index}`, title: `Функция ${index}` })) };
    const review = reviewStage('features', many, { process, projectType: 'booking' });
    const warning = review.findings.find((finding) => finding.code === 'SPEC_FIRST_VERSION_LARGE');
    assert.equal(warning?.severity, 'important');
    assert.ok(!codes(spec).includes('SPEC_FIRST_VERSION_LARGE'));
  });

  it('older results without the new parts still read and review', () => {
    const old = { roles: [{ key: 'client', name: 'Клиент', description: '' }], features: [{ key: 'f1', title: 'Запись', description: '', roles: ['client'], priority: 'must', acceptance: ['Клиент записывается и видит подтверждение'], data: [] }], sensitivity: 'normal', integrations: [] };
    const value = normalizeFeatures(old);
    assert.deepEqual([value.summary, value.requirements, value.limits, value.questions], ['', [], [], []]);
    assert.doesNotThrow(() => reviewStage('features', old, { process, projectType: 'booking' }));
  });

  it('the document has the parts a developer needs, and the architecture names what is put off', () => {
    const spec = templateFeatures(brief, process, 'site');
    const withLater: AppFeatures = { ...spec, features: [...spec.features, { key: 'pay', title: 'Онлайн-оплата', description: '', roles: [spec.roles[0]!.key], priority: 'later', acceptance: [], data: [] }], limits: ['Без онлайн-оплаты в первой версии'], questions: ['Брать ли предоплату?'] };
    const md = specMarkdown({ brief, process, features: withLater, locale: 'ru' });
    for (const part of ['техническое задание', '## Функции', 'Обязательно в первой версии', 'Позже', 'Готово, когда', '## Общие требования', '## Ограничения и допущения', '## Открытые вопросы', '## Бизнес-правила']) assert.ok(md.includes(part), part);
    const plan = buildTechPlan({ projectType: 'landing', brief, schedule: null, process, spec: withLater }, null);
    assert.ok(plan.limits.includes('По ТЗ позже: Онлайн-оплата.') && plan.limits.includes('Без онлайн-оплаты в первой версии'));
  });
});
