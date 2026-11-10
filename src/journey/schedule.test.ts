import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArtifactValidationError } from './artifacts.js';
import { localClock, localDay, normalizeSchedule, openDays, scheduleIssues, slotsFor, templateSchedule, zonedTime, type Schedule } from './schedule.js';

const day = { from: '10:00', to: '13:00' };
const schedule: Schedule = normalizeSchedule({
  timezone: 'Asia/Almaty',
  services: [{ name: 'Маникюр', minutes: 90 }, { name: 'Педикюр', minutes: 60 }],
  masters: [
    { key: 'm1', name: 'Айгерим', services: [], week: [day, day, day, day, day, null, null] },
    { key: 'm2', name: 'Дана', services: ['Педикюр'], week: [null, day, null, null, null, null, null] },
  ],
  rules: { slotStep: 30, minNoticeHours: 2, horizonDays: 7, cancelHours: 3 },
});
// Tuesday 10 November 2026, 07:00 in Almaty (02:00 UTC).
const now = new Date('2026-11-10T02:00:00Z');

describe('Booking schedule', () => {
  it('converts wall-clock time in the zone', () => {
    assert.equal(zonedTime('2026-11-10', 10 * 60, 'Asia/Almaty').toISOString(), '2026-11-10T05:00:00.000Z');
    assert.equal(zonedTime('2026-11-10', 10 * 60, 'Europe/Moscow').toISOString(), '2026-11-10T07:00:00.000Z');
    assert.equal(localDay(new Date('2026-11-10T20:30:00Z'), 'Asia/Almaty'), '2026-11-11');
    assert.equal(localClock(new Date('2026-11-10T05:30:00Z'), 'Asia/Almaty'), '10:30');
  });

  it('offers start times within working hours, with room for the whole service', () => {
    const slots = slotsFor(schedule, 'Маникюр', null, '2026-11-11', [], now);
    assert.deepEqual(slots.map((slot) => localClock(slot.startsAt, 'Asia/Almaty')), ['10:00', '10:30', '11:00', '11:30']);
    assert.deepEqual(slots[0]!.masterKeys, ['m1']);
  });

  it('respects the minimum notice, the horizon and days off', () => {
    // 07:00 now + 2 h notice → the first start today is 10:00 (already past 09:00).
    const lateNow = new Date('2026-11-10T05:10:00Z'); // 10:10 local
    assert.deepEqual(slotsFor(schedule, 'Педикюр', null, '2026-11-10', [], lateNow).map((slot) => localClock(slot.startsAt, 'Asia/Almaty')), []);
    assert.equal(slotsFor(schedule, 'Маникюр', null, '2026-11-14', [], now).length, 0); // Saturday off
    assert.equal(slotsFor(schedule, 'Маникюр', null, '2026-11-20', [], now).length, 0); // beyond 7 days
    assert.equal(slotsFor(schedule, 'Маникюр', null, '2026-11-09', [], now).length, 0); // the past
  });

  it('removes times that overlap an existing booking of that master; «any master» uses who is free', () => {
    const busy = [{ masterKey: 'm1', startsAt: zonedTime('2026-11-10', 11 * 60, 'Asia/Almaty'), endsAt: zonedTime('2026-11-10', 12 * 60, 'Asia/Almaty') }];
    const any = slotsFor(schedule, 'Педикюр', null, '2026-11-10', busy, now);
    assert.deepEqual(any.map((slot) => `${localClock(slot.startsAt, 'Asia/Almaty')}:${slot.masterKeys.join('+')}`), ['10:00:m1+m2', '10:30:m2', '11:00:m2', '11:30:m2', '12:00:m1+m2']);
    const onlyFirst = slotsFor(schedule, 'Педикюр', 'm1', '2026-11-10', busy, now);
    assert.deepEqual(onlyFirst.map((slot) => localClock(slot.startsAt, 'Asia/Almaty')), ['10:00', '12:00']);
  });

  it('lists only days with free time', () => {
    assert.deepEqual(openDays(schedule, 'Маникюр', null, [], now).map((item) => item.day), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16']);
  });

  it('validates input and explains what blocks booking', () => {
    assert.throws(() => normalizeSchedule({ ...schedule, timezone: 'Mars/Base' }), ArtifactValidationError);
    assert.throws(() => normalizeSchedule({ ...schedule, services: [{ name: 'A', minutes: 7 }] }), ArtifactValidationError);
    assert.throws(() => normalizeSchedule({ ...schedule, masters: [{ ...schedule.masters[0], week: [{ from: '12:00', to: '10:00' }, null, null, null, null, null, null] }] }), ArtifactValidationError);
    const unknown = normalizeSchedule({ ...schedule, masters: [{ ...schedule.masters[1], services: ['Педикюр', 'Стрижка'] }] });
    assert.deepEqual(unknown.masters[0]!.services, ['Педикюр']);
    assert.match(scheduleIssues(unknown).map((issue) => issue.message).join(' '), /«Маникюр» не делает ни один мастер/);
    assert.deepEqual(scheduleIssues(schedule), []);
    const template = templateSchedule({ services: [{ name: 'Стрижка', description: null, price: '5000' }], hours: null });
    assert.equal(template.services[0]!.minutes, 60);
    assert.deepEqual(scheduleIssues(template), []);
  });
});
