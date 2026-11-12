import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { change, conversion, fillDays, periodOf, top } from './insights-rules.js';

describe('after-launch summary', () => {
  it('accepts 7, 30 or 90 days and falls back to 30', () => {
    assert.equal(periodOf('7'), 7);
    assert.equal(periodOf(90), 90);
    assert.equal(periodOf('365'), 30);
    assert.equal(periodOf(undefined), 30);
  });
  it('fills every day of the period, oldest first', () => {
    const days = fillDays([{ day: '2026-11-10', views: 3 }, { day: '2026-11-12', views: 5 }, { day: '2026-11-12', views: 1 }], '2026-11-12', 4);
    assert.deepEqual(days, [{ day: '2026-11-09', views: 0 }, { day: '2026-11-10', views: 3 }, { day: '2026-11-11', views: 0 }, { day: '2026-11-12', views: 6 }]);
  });
  it('compares with the previous period and counts leads per hundred views', () => {
    assert.equal(change(150, 100), 50);
    assert.equal(change(80, 100), -20);
    assert.equal(change(10, 0), null);
    assert.equal(conversion(3, 200), 1.5);
    assert.equal(conversion(1, 0), null);
  });
  it('keeps the list short and sums the rest', () => {
    const rows = [{ name: 'a', views: 1 }, { name: 'b', views: 9 }, { name: 'c', views: 5 }, { name: 'd', views: 2 }];
    assert.deepEqual(top(rows, 2, (views) => ({ name: 'other', views })), [{ name: 'b', views: 9 }, { name: 'c', views: 5 }, { name: 'other', views: 3 }]);
  });
});
