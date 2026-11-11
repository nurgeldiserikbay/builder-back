import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArtifactValidationError } from './artifacts.js';
import { normalizeSchedule } from './schedule.js';
import { buildTechPlan, coverageOf, sameTechPlan, techPlanMarkdown, techPlanNotes } from './techplan.js';
import { normalizeProcess, processIssues, templateProcess } from './process.js';

const h = { from: '10:00', to: '19:00' };
const schedule = normalizeSchedule({
  timezone: 'Asia/Almaty', services: [{ name: 'Стрижка', minutes: 45 }],
  masters: [{ key: 'm1', name: 'Арман', services: [], week: [h, h, h, h, h, null, null] }], rules: { slotStep: 15, minNoticeHours: 1, horizonDays: 14, cancelHours: 2 },
});

describe('Technical plan', () => {
  it('is derived from the accepted schedule, the same for the same inputs', () => {
    const plan = buildTechPlan({ brief: null, projectType: 'booking', process: null, schedule }, null);
    assert.deepEqual(buildTechPlan({ brief: null, projectType: 'booking', process: null, schedule }, null), plan);
    assert.match(plan.dataModel.find((item) => item.key === 'service')!.plain, /Стрижка \(45 мин\)/);
    assert.match(plan.dataModel.find((item) => item.key === 'master')!.plain, /Арман: Стрижка; Пн 10:00–19:00, Вт/);
    assert.deepEqual(plan.sequences.map((item) => item.title), ['Запись', 'Отмена']);
    for (const sequence of plan.sequences) for (const message of sequence.messages) assert.ok(sequence.participants[message.from] && sequence.participants[message.to]);
    assert.match(plan.features[0]!.plain, /каждые 15 мин, не раньше чем через 1 ч и не дальше 14 дн/);
    assert.match(plan.api, /^openapi: 3\.1\.0/);
    for (const path of ['/book:', '/__forms/booking:', '/book/b/{token}:', '/__forms/booking-cancel:']) assert.ok(plan.api.includes(path), path);
  });

  it('tells an outdated plan apart, ignoring notes and key order', () => {
    const plan = buildTechPlan({ brief: null, projectType: 'booking', process: null, schedule }, null);
    const withNotes: Record<string, unknown> = { ...plan, ownerNotes: 'заметка' };
    const reordered = Object.fromEntries(Object.keys(withNotes).reverse().map((key) => [key, withNotes[key]])) as unknown as typeof plan;
    assert.equal(sameTechPlan(plan, reordered), true);
    const longer = buildTechPlan({ brief: null, projectType: 'booking', process: null, schedule: { ...schedule, services: [{ name: 'Стрижка', minutes: 60 }] } }, null);
    assert.equal(sameTechPlan(plan, longer), false);
  });

  it('takes only notes from the owner', () => {
    assert.equal(techPlanNotes({ ownerNotes: '  Позже — предоплата через Kaspi  ', summary: 'подмена' }), 'Позже — предоплата через Kaspi');
    assert.equal(techPlanNotes({}), null);
    assert.throws(() => techPlanNotes({ ownerNotes: 'x'.repeat(2001) }), ArtifactValidationError);
    const markdown = techPlanMarkdown(buildTechPlan({ brief: null, projectType: 'booking', process: null, schedule }, 'Позже — предоплата'));
    assert.match(markdown, /## Заметки владельца\n\nПозже — предоплата/);
  });
});

describe('Business process and architecture', () => {
  it('starts from a typical process of the project type', () => {
    const booking = normalizeProcess(templateProcess('booking', null));
    assert.deepEqual(processIssues(booking), []);
    assert.ok(booking.actors.some((actor) => actor.kind === 'client'));
    const landing = normalizeProcess(templateProcess('landing', { businessName: 'Торты', whatYouDo: '', audience: '', city: null, mainAction: 'form', phone: null, messenger: null, email: null, address: null, tone: null }));
    assert.ok(landing.scenarios[0]!.steps.some((step) => step.capability === 'request_form'));
  });

  it('keeps steps tied to participants and drops broken links', () => {
    const process = normalizeProcess({
      actors: [{ key: 'client', name: 'Клиент', kind: 'client' }, { key: 'owner', name: 'Я', kind: 'business' }],
      scenarios: [{ key: 's', title: 'Заказ', goal: '', steps: [{ actor: 'ghost', action: 'Пишет', capability: 'teleport' }, { actor: 'owner', action: 'Отвечает', capability: 'offline' }] }],
      rules: ['Предоплата 30%'],
      data: [{ key: 'order', name: 'Заказ', fields: ['Сумма'], links: [{ to: 'nowhere', kind: 'many', label: 'x' }] }],
    });
    assert.equal(process.scenarios[0]!.steps[0]!.actor, 'client');
    assert.equal(process.scenarios[0]!.steps[0]!.capability, 'other');
    assert.deepEqual(process.data[0]!.links, []);
    assert.throws(() => normalizeProcess({ actors: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}`, kind: 'client' })) }), ArtifactValidationError);
  });

  it('says honestly which steps of the process the product covers', () => {
    const process = normalizeProcess({
      actors: [{ key: 'client', name: 'Клиент', kind: 'client' }, { key: 'owner', name: 'Я', kind: 'business' }],
      scenarios: [{ key: 's', title: 'Запись', goal: '', steps: [
        { actor: 'client', action: 'Выбирает время', capability: 'choose_slot' },
        { actor: 'client', action: 'Платит 30%', capability: 'pay_online' },
        { actor: 'owner', action: 'Перезванивает', capability: 'offline' },
      ] }], rules: [], data: [{ name: 'Клиент', fields: [], links: [] }],
    });
    assert.deepEqual(coverageOf('booking', null, process).map((step) => step.status), ['built', 'not_built', 'manual']);
    assert.deepEqual(coverageOf('site', 'call', process).map((step) => step.status), ['not_built', 'not_built', 'manual']);
    const site = buildTechPlan({ projectType: 'landing', brief: null, schedule: null, process }, null);
    assert.equal(site.kind, 'site');
    assert.equal(site.api, '');
    assert.equal(site.coverage!.length, 3);
    assert.match(techPlanMarkdown(site), /✗ Запись — Клиент: Платит 30%/);
  });
});
