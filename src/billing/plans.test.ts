import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { monthStart, planOf, plans, priceOf, validContactUrl } from './plans.js';

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
  it('formats prices in tenge and leaves unset paid prices empty', () => {
    assert.equal(priceOf(plans.free, null), 'Бесплатно');
    assert.equal(priceOf(plans.start, null), null);
    assert.equal(priceOf(plans.start, 4990), '4\u00a0990\u00a0₸ в месяц');
    assert.equal(priceOf(plans.business, 1499000), '1\u00a0499\u00a0000\u00a0₸ в месяц');
  });
  it('accepts only safe upgrade contacts', () => {
    assert.equal(validContactUrl('https://t.me/buildpath_sales'), 'https://t.me/buildpath_sales');
    assert.equal(validContactUrl('mailto:sales@example.kz'), 'mailto:sales@example.kz');
    for (const bad of ['http://example.kz', 'javascript:alert(1)', 'https://user:pass@example.kz', 'https://localhost', 'tg://resolve?domain=x', '', null]) {
      assert.equal(validContactUrl(bad), null, String(bad));
    }
  });
});
