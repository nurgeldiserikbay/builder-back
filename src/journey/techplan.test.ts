import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArtifactValidationError } from './artifacts.js';
import { normalizeSchedule } from './schedule.js';
import { buildTechPlan, sameTechPlan, techPlanMarkdown, techPlanNotes } from './techplan.js';

const h = { from: '10:00', to: '19:00' };
const schedule = normalizeSchedule({
  timezone: 'Asia/Almaty', services: [{ name: 'Стрижка', minutes: 45 }],
  masters: [{ key: 'm1', name: 'Арман', services: [], week: [h, h, h, h, h, null, null] }], rules: { slotStep: 15, minNoticeHours: 1, horizonDays: 14, cancelHours: 2 },
});

describe('Technical plan', () => {
  it('is derived from the accepted schedule, the same for the same inputs', () => {
    const plan = buildTechPlan({ brief: null, offer: null, schedule }, null);
    assert.deepEqual(buildTechPlan({ brief: null, offer: null, schedule }, null), plan);
    assert.match(plan.data[0]!.plain, /Стрижка \(45 мин\)/);
    assert.match(plan.data[0]!.plain, /Арман: Стрижка; Пн 10:00–19:00, Вт/);
    assert.match(plan.features[0]!.plain, /каждые 15 мин, не раньше чем через 1 ч и не дальше 14 дн/);
    assert.match(plan.api, /^openapi: 3\.1\.0/);
    for (const path of ['/book:', '/__forms/booking:', '/book/b/{token}:', '/__forms/booking-cancel:']) assert.ok(plan.api.includes(path), path);
  });

  it('tells an outdated plan apart, ignoring notes and key order', () => {
    const plan = buildTechPlan({ brief: null, offer: null, schedule }, null);
    const withNotes: Record<string, unknown> = { ...plan, ownerNotes: 'заметка' };
    const reordered = Object.fromEntries(Object.keys(withNotes).reverse().map((key) => [key, withNotes[key]])) as unknown as typeof plan;
    assert.equal(sameTechPlan(plan, reordered), true);
    const longer = buildTechPlan({ brief: null, offer: null, schedule: { ...schedule, services: [{ name: 'Стрижка', minutes: 60 }] } }, null);
    assert.equal(sameTechPlan(plan, longer), false);
  });

  it('takes only notes from the owner', () => {
    assert.equal(techPlanNotes({ ownerNotes: '  Позже — предоплата через Kaspi  ', summary: 'подмена' }), 'Позже — предоплата через Kaspi');
    assert.equal(techPlanNotes({}), null);
    assert.throws(() => techPlanNotes({ ownerNotes: 'x'.repeat(2001) }), ArtifactValidationError);
    const markdown = techPlanMarkdown(buildTechPlan({ brief: null, offer: null, schedule }, 'Позже — предоплата'));
    assert.match(markdown, /## Заметки владельца\n\nПозже — предоплата/);
  });
});
