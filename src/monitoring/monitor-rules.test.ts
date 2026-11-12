import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration, nextState, probeOk, weekStart, weeklyReportDue, type MonitorState } from './monitor-rules.js';

const up: MonitorState = { status: 'up', failures: 0, downSince: null, alertedAt: null };
const fail = { ok: false, status: null, ms: 10_000, error: 'TIMEOUT' };
const fine = { ok: true, status: 200, ms: 120, error: null };

describe('site monitoring', () => {
  it('counts a site down only after two failed checks in a row, alerts once and reports the recovery', () => {
    const now = new Date('2026-11-12T10:20:00Z');
    const first = nextState(up, fail, now);
    assert.equal(first.state.status, 'up');
    assert.equal(first.alert, null);
    const second = nextState(first.state, fail, now);
    assert.equal(second.state.status, 'down');
    assert.equal(second.alert, 'down');
    assert.equal(second.incident, 'open');
    assert.equal(second.state.downSince?.toISOString(), '2026-11-12T10:10:00.000Z');
    const third = nextState(second.state, fail, now);
    assert.equal(third.alert, null);
    assert.equal(third.incident, null);
    const back = nextState(third.state, fine, now);
    assert.deepEqual(back, { state: up, alert: 'recovered', incident: 'close' });
  });
  it('a single failure followed by success changes nothing for the owner', () => {
    const blip = nextState(nextState(up, fail).state, fine);
    assert.deepEqual(blip, { state: up, alert: null, incident: null });
  });
  it('treats pages and redirects as reachable', () => {
    assert.equal(probeOk(200), true);
    assert.equal(probeOk(301), true);
    assert.equal(probeOk(404), false);
    assert.equal(probeOk(502), false);
    assert.equal(probeOk(null), false);
  });
  it('sends the weekly report on Monday from 9:00 local time, once a week', () => {
    // Monday 16 Nov 2026, 09:30 in Almaty is 04:30 UTC.
    const monday = new Date('2026-11-16T04:30:00Z');
    assert.equal(weekStart('Asia/Almaty', monday), '2026-11-16');
    assert.equal(weekStart('Asia/Almaty', new Date('2026-11-15T20:00:00Z')), '2026-11-16'); // already Monday 01:00 there
    assert.equal(weekStart('Asia/Almaty', new Date('2026-11-12T10:00:00Z')), '2026-11-09');
    assert.deepEqual(weeklyReportDue('Asia/Almaty', null, monday), { due: true, week: '2026-11-16' });
    assert.equal(weeklyReportDue('Asia/Almaty', '2026-11-16', monday).due, false);
    assert.equal(weeklyReportDue('Asia/Almaty', null, new Date('2026-11-16T03:00:00Z')).due, false); // 08:00 there
    assert.equal(weeklyReportDue('Asia/Almaty', '2026-11-09', new Date('2026-11-17T05:00:00Z')).due, true); // missed on Monday: goes on Tuesday
    assert.equal(weeklyReportDue('Asia/Almaty', '2026-11-16', new Date('2026-11-17T05:00:00Z')).due, false); // already sent this week
  });
  it('rounds downtime to minutes', () => {
    assert.deepEqual(duration(80 * 60_000), { hours: 1, minutes: 20 });
    assert.deepEqual(duration(5_000), { hours: 0, minutes: 1 });
  });
});
