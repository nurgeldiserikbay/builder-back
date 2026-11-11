import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBookingForm, parseQuery } from './booking-pages.js';
import { canClientCancel } from './booking-store.js';
import { bookingText } from '../notifications/booking-notifier.js';

const form = (extra: Record<string, string>) => new URLSearchParams({ s: '1', m: 'any', t: '2026-11-11T05:00:00.000Z', name: 'Ержан', phone: '+7 (701) 111-22-33', consent: 'yes', ...extra }).toString();

describe('Booking pages', () => {
  it('reads only well-formed steps from the address', () => {
    assert.deepEqual(parseQuery(new URL('http://x/book?s=2&m=m1&d=2026-11-11')), { service: 2, master: 'm1', day: '2026-11-11', start: null });
    assert.deepEqual(parseQuery(new URL('http://x/book?s=abc&m=<x>&t=yesterday')), { service: null, master: null, day: null, start: null });
  });

  it('validates the booking form and keeps what the client typed on errors', () => {
    const ok = parseBookingForm(form({ comment: '  ' }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual({ ...ok.form, start: ok.form.start.toISOString() }, { service: 1, master: 'any', start: '2026-11-11T05:00:00.000Z', name: 'Ержан', phone: '+7 (701) 111-22-33', comment: null, email: null });
    const noConsent = parseBookingForm(form({ consent: '' }));
    assert.equal(noConsent.ok, false);
    if (!noConsent.ok) { assert.match(noConsent.error, /согласие/); assert.equal(noConsent.values.name, 'Ержан'); }
    const phone = parseBookingForm(form({ phone: '12345' }));
    assert.equal(!phone.ok && /телефон/.test(phone.error), true);
    const spam = parseBookingForm(form({ website: 'http://spam' }));
    assert.equal(!spam.ok && spam.spam, true);
  });

  it('lets the client cancel only an active booking before the deadline', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    assert.equal(canClientCancel({ status: 'booked', startsAt: new Date('2026-11-11T03:00:00Z') }, 3, now), true);
    assert.equal(canClientCancel({ status: 'booked', startsAt: new Date('2026-11-11T02:59:00Z') }, 3, now), false);
    assert.equal(canClientCancel({ status: 'cancelled_by_owner', startsAt: new Date('2026-11-12T00:00:00Z') }, 3, now), false);
  });

  it('writes the owner message in local time', () => {
    const text = bookingText({ kind: 'created', siteName: 'Усы', projectId: 'p1', serviceName: 'Стрижка', masterName: 'Арман', startsAt: new Date('2026-11-11T05:00:00Z'), timezone: 'Asia/Almaty', clientName: 'Ержан', clientPhone: '+77011112233', comment: null }, 'https://app.example.kz');
    assert.match(text, /Новая запись с сайта «Усы»\nСтрижка — Ср, 11 ноября, 10:00\nМастер: Арман\nКлиент: Ержан, \+77011112233\nВсе записи: https:\/\/app\.example\.kz\/projects\/p1\/bookings/);
  });
});
