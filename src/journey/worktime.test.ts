import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amountFor, effectiveStatus, minutesOf, plannedAmount, summarize, withoutResult } from './worktime.js';
import { termsText } from './specialists.service.js';

const now = new Date('2026-11-10T12:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
const entry = (minutes: number, extra: Partial<{ source: string; actions: number; status: string; createdAt: Date }> = {}) => ({
  startedAt: at(minutes + 10), endedAt: at(10), source: 'tracked', actions: 3, status: 'approved', createdAt: at(5), ...extra,
});
const hourly = { payKind: 'hourly', fixedAmountTiyn: null, hourlyRateTiyn: 600_000, hourLimit: 2, onlyResultTime: false }; // 6 000 ₸/h, 2 h

describe('Specialist time and payment', () => {
  it('counts whole minutes, at least one', () => {
    assert.equal(minutesOf({ startedAt: at(1), endedAt: at(1) }), 1);
    assert.equal(minutesOf({ startedAt: at(30.2), endedAt: at(0) }), 31);
  });

  it('treats undisputed entries as approved after 3 days', () => {
    assert.equal(effectiveStatus({ status: 'pending', createdAt: at(60) }, now), 'pending');
    assert.equal(effectiveStatus({ status: 'pending', createdAt: at(3 * 24 * 60 + 1) }, now), 'auto_approved');
    assert.equal(effectiveStatus({ status: 'disputed', createdAt: at(5 * 24 * 60) }, now), 'disputed');
  });

  it('marks tracked time without actions as time without result; manual entries are judged by the owner', () => {
    assert.equal(withoutResult({ source: 'tracked', actions: 0 }), true);
    assert.equal(withoutResult({ source: 'tracked', actions: 2 }), false);
    assert.equal(withoutResult({ source: 'manual', actions: 0 }), false);
  });

  it('pays approved minutes × rate, never above the hour limit; pending and disputed time is not paid', () => {
    const summary = summarize([entry(90), entry(60), entry(30, { status: 'pending' }), entry(20, { status: 'disputed' })], hourly, now);
    assert.equal(summary.approvedMinutes, 150);
    assert.equal(summary.payableMinutes, 120);
    assert.equal(summary.pendingMinutes, 30);
    assert.equal(summary.disputedMinutes, 20);
    assert.equal(summary.amountDueTiyn, 1_200_000); // 2 h × 6 000 ₸
    assert.equal(summary.limitReached, true);
  });

  it('with «only time with result» excludes tracked intervals without actions', () => {
    const entries = [entry(60), entry(30, { actions: 0 })];
    assert.equal(summarize(entries, hourly, now).amountDueTiyn, 900_000);
    const summary = summarize(entries, { ...hourly, onlyResultTime: true }, now);
    assert.equal(summary.noResultMinutes, 30);
    assert.equal(summary.amountDueTiyn, 600_000);
  });

  it('a fixed price does not depend on time; no terms means nothing through the platform', () => {
    const fixed = { payKind: 'fixed', fixedAmountTiyn: 15_000_000, hourlyRateTiyn: null, hourLimit: null, onlyResultTime: false };
    assert.equal(summarize([entry(500)], fixed, now).amountDueTiyn, 15_000_000);
    assert.equal(amountFor({ ...fixed, payKind: 'none' }, 100), 0);
    assert.equal(plannedAmount(fixed), 15_000_000);
    assert.equal(plannedAmount(hourly), 1_200_000);
  });

  it('describes the terms in one plain sentence', () => {
    assert.match(termsText({ payKind: 'hourly', fixedAmount: null, hourlyRate: 6000, hourLimit: 20, weeklyHourLimit: 10, revisionsIncluded: null, onlyResultTime: true }), /6\s000 ₸ в час, не больше 20 ч на этап, до 10 ч в неделю, оплачивается только время/);
    assert.match(termsText({ payKind: 'fixed', fixedAmount: 150000, hourlyRate: null, hourLimit: null, weeklyHourLimit: null, revisionsIncluded: 2, onlyResultTime: false }), /Фиксированная цена за этап: 150\s000 ₸.*правок: 2/);
    assert.match(termsText({ payKind: 'none', fixedAmount: null, hourlyRate: null, hourLimit: null, weeklyHourLimit: null, revisionsIncluded: null, onlyResultTime: false }), /Без оплаты через платформу/);
  });
});
