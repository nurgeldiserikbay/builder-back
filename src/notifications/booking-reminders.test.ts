import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reminderEmail, reminderFields, reminderTime } from './booking-reminders.js';
import { parseBookingForm } from '../sites/booking-pages.js';
import { openSecret, secretKey } from '../common/secret-box.js';

const H = 3_600_000;
const at = (iso: string) => new Date(iso);

describe('Booking reminders', () => {
  it('reminds a day before, or two hours before when booked late, or not at all', () => {
    const start = at('2026-11-20T10:00:00Z');
    assert.equal(reminderTime(start, at('2026-11-15T10:00:00Z'))?.toISOString(), '2026-11-19T10:00:00.000Z');
    assert.equal(reminderTime(start, at('2026-11-19T20:00:00Z'))?.toISOString(), '2026-11-20T08:00:00.000Z');
    assert.equal(reminderTime(start, at('2026-11-20T07:30:00Z')), null);
  });

  it('stores the address and a sealed cancel link only when mail is configured', () => {
    const env = { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.kz', CODE_HOSTING_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } as NodeJS.ProcessEnv;
    const fields = reminderFields('aigerim@mail.kz', 'TOKEN123', at('2026-11-20T10:00:00Z'), at('2026-11-15T10:00:00Z'), env) as Record<string, unknown>;
    assert.equal(fields.reminderStatus, 'pending');
    assert.equal(openSecret(fields.cancelLinkSealed as string, secretKey(env)!), 'TOKEN123');
    assert.deepEqual(reminderFields('aigerim@mail.kz', 'T', at('2026-11-20T10:00:00Z'), at('2026-11-15T10:00:00Z'), {} as NodeJS.ProcessEnv), {});
    assert.deepEqual(reminderFields(null, 'T', at('2026-11-20T10:00:00Z'), at('2026-11-15T10:00:00Z'), env), {});
  });

  it('writes a short reminder in the site time zone and escapes client text', () => {
    const mail = reminderEmail({
      siteName: 'Барбершоп «Усы»', siteUrl: 'https://usy-barber.com', serviceName: 'Стрижка', masterName: 'Арман', startsAt: at('2026-11-20T10:00:00Z'), timezone: 'Asia/Almaty',
      minutes: 45, price: '5 000 ₸', clientName: '<b>Айгерим</b>', cancelUrl: 'https://usy-barber.com/book/b/abc', canCancel: true, cancelHours: 3, contacts: [{ label: 'Телефон', value: '+7 700 000 00 00' }],
    }, at('2026-11-19T10:00:00Z'));
    assert.match(mail.subject, /завтра в 15:00/);
    assert.match(mail.html, /&lt;b&gt;Айгерим/);
    assert.match(mail.html, /book\/b\/abc/);
    const late = reminderEmail({ ...{ siteName: 'X', siteUrl: 'https://x.kz', serviceName: 'S', masterName: 'M', startsAt: at('2026-11-20T10:00:00Z'), timezone: 'Asia/Almaty', minutes: 30, price: null, clientName: 'A', contacts: [] }, cancelUrl: 'https://x.kz/book/b/abc', canCancel: false, cancelHours: 3 }, at('2026-11-20T08:00:00Z'));
    assert.match(late.subject, /сегодня в 15:00/);
    assert.doesNotMatch(late.html, /book\/b\/abc/);
  });

  it('accepts an optional e-mail on the booking form', () => {
    const base = 's=0&m=any&t=2026-11-20T10%3A00%3A00.000Z&name=A&phone=%2B77000000000&consent=yes';
    const ok = parseBookingForm(`${base}&email=Aigerim%40Mail.kz`);
    assert.equal(ok.ok && ok.form.email, 'aigerim@mail.kz');
    const none = parseBookingForm(base);
    assert.equal(none.ok && none.form.email, null);
    const bad = parseBookingForm(`${base}&email=not-an-email`);
    assert.equal(bad.ok, false);
  });
});
