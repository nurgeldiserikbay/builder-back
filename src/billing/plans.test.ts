import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { monthStart, planOf, plans, priceOf } from './plans.js';

describe('plans', () => {
  it('falls back to the free plan for unknown or expired plans', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    assert.equal(planOf(null, null, now).plan.key, 'free');
    assert.equal(planOf('enterprise', null, now).plan.key, 'free');
    assert.deepEqual([planOf('start', new Date('2026-12-01'), now).plan.key, planOf('start', new Date('2026-12-01'), now).expired], ['start', false]);
    assert.deepEqual([planOf('start', new Date('2026-11-01'), now).plan.key, planOf('start', new Date('2026-11-01'), now).expired], ['free', true]);
  });
  it('grows limits with each plan and keeps specialists paid', () => {
    for (const key of ['projects', 'aiPerMonth', 'liveSites'] as const) {
      assert.ok(plans.free.limits[key] < plans.start.limits[key] && plans.start.limits[key] < plans.business.limits[key], key);
    }
    assert.equal(plans.free.specialists, false);
    assert.equal(plans.start.specialists, true);
  });
  it('counts AI usage from the first day of the UTC month', () => {
    assert.equal(monthStart(new Date('2026-11-30T23:59:00Z')).toISOString(), '2026-11-01T00:00:00.000Z');
  });
  it('shows prices only when configured', () => {
    assert.equal(priceOf(plans.free, {}), 'Бесплатно');
    assert.equal(priceOf(plans.start, {}), null);
    assert.equal(priceOf(plans.start, { PLAN_PRICE_START: '4 990 ₸ в месяц' }), '4 990 ₸ в месяц');
  });
});
