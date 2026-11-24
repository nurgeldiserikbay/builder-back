import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyByStatus, weekMinutes } from './work-rules.js';

test('a specialist sees what the owner still has to pay, what BuildPath holds and what was paid out', () => {
  const money = moneyByStatus([
    { amountTiyn: 10_000, payoutTiyn: null, status: 'due' },
    { amountTiyn: 5_000, payoutTiyn: 4_500, status: 'checkout' },
    { amountTiyn: 20_000, payoutTiyn: 18_000, status: 'held' },
    { amountTiyn: 30_000, payoutTiyn: 27_000, status: 'paid_out' },
    { amountTiyn: 7_000, payoutTiyn: null, status: 'paid_direct' },
    { amountTiyn: 9_000, payoutTiyn: 8_100, status: 'refunded' },
  ]);
  assert.deepEqual(money, { awaitingOwner: 15_000, held: 18_000, paidOut: 34_000 });
});

test('held money without a known fee is shown in full', () => {
  assert.equal(moneyByStatus([{ amountTiyn: 1_000, payoutTiyn: null, status: 'held' }]).held, 1_000);
});

test('the week is the last 7 × 24 hours', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const entry = (hoursAgo: number, minutes: number) => ({ startedAt: new Date(now.getTime() - hoursAgo * 3_600_000), endedAt: new Date(now.getTime() - hoursAgo * 3_600_000 + minutes * 60_000) });
  assert.equal(weekMinutes([entry(2, 30), entry(24 * 6, 60), entry(24 * 8, 90)], now), 90);
});
