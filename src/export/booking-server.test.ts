import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { normalizeSchedule } from '../journey/schedule.js';
import { bookingPackageFiles } from './booking-package.js';
import { createBookingApp, type ExportConfig } from './booking-server.js';

const h = { from: '10:00', to: '12:00' };
const schedule = normalizeSchedule({
  timezone: 'Asia/Almaty', services: [{ name: 'Стрижка', minutes: 60 }],
  masters: [{ key: 'm1', name: 'Арман', services: [], week: [h, h, h, h, h, h, h] }], rules: { slotStep: 60, minNoticeHours: 0, horizonDays: 3, cancelHours: 2 },
});
const meta = { businessName: 'Усы', locale: 'ru', hasForm: true, ownerContacts: [{ label: 'Телефон', value: '+77010000000' }],
  theme: { background: '#fff', text: '#111', muted: '#444', accent: '#000', accentText: '#fff', font: 'sans-serif', radius: '8px' }, booking: { schedule, prices: { Стрижка: '6 000 ₸' } } };
const config: ExportConfig = { version: '1.0.0', meta, booking: meta.booking };
const now = new Date('2026-11-10T02:00:00Z'); // 07:00 in Almaty

describe('Exported booking app', () => {
  let dir = ''; let base = ''; let close = () => {};
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'booking-'));
    const app = createBookingApp({ config, html: '<!doctype html><a href="/book">Записаться</a>', dataDir: dir, adminPassword: 'correct horse', telegram: null, now: () => now });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.server.close();
  });
  after(async () => { close(); await rm(dir, { recursive: true, force: true }); });

  const book = (start: string, name: string) => fetch(`${base}/__forms/booking`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ s: '0', m: 'any', t: start, name, phone: '+77011112233', consent: 'yes' }),
  });

  it('serves the site and the booking steps', async () => {
    assert.match(await (await fetch(base)).text(), /Записаться/);
    const times = await (await fetch(`${base}/book?s=0&m=m1&d=2026-11-10`)).text();
    assert.match(times, /10:00/); assert.match(times, /11:00/);
  });

  it('stores a booking in the data file, refuses the same time and lets the client cancel', async () => {
    const first = await book('2026-11-10T05:00:00.000Z', 'Ержан');
    assert.equal(first.status, 303);
    const link = first.headers.get('location')!;
    assert.match(link, /^\/book\/b\/[A-Za-z0-9_-]{32}\?new=1$/);
    assert.equal((await book('2026-11-10T05:00:00.000Z', 'Другой')).status, 409);
    const parallel = await Promise.all([book('2026-11-10T06:00:00.000Z', 'A'), book('2026-11-10T06:00:00.000Z', 'B'), book('2026-11-10T06:00:00.000Z', 'C')]);
    assert.deepEqual(parallel.map((response) => response.status).sort(), [303, 409, 409]);
    const stored = JSON.parse(await readFile(path.join(dir, 'bookings.json'), 'utf8')) as Array<{ clientName: string; tokenHash: string }>;
    assert.equal(stored.length, 2);
    assert.ok(!JSON.stringify(stored).includes(link.slice(8, 40)), 'only the token hash is stored');
    const token = link.slice(8, 40);
    const cancelled = await fetch(`${base}/__forms/booking-cancel`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
    assert.equal(cancelled.status, 303);
    assert.match(await (await fetch(`${base}/book/b/${token}`)).text(), /Запись отменена/);
  });

  it('shows bookings to the owner only with the password', async () => {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    assert.equal((await fetch(`${base}/admin`, { headers: { authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` } })).status, 401);
    const page = await fetch(`${base}/admin`, { headers: { authorization: `Basic ${Buffer.from('owner:correct horse').toString('base64')}` } });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /отменил клиент/); assert.match(text, /записан/);
  });

  it('packs the app with config, instructions and no secrets', () => {
    const files = bookingPackageFiles({ html: '<html></html>', meta, checks: [], sourceVersionIds: {}, compiledAt: '2026-11-10T00:00:00Z' }, '// bundle');
    assert.deepEqual(files.map((file) => file.name), ['app/server.mjs', 'app/config.json', 'app/index.html', 'Caddyfile', 'compose.yaml', '.env.example', 'README.md']);
    assert.equal(JSON.parse(files[1]!.content).booking.schedule.masters[0].name, 'Арман');
    assert.match(files[5]!.content, /^ADMIN_PASSWORD=$/m);
    assert.match(files[3]!.content, /reverse_proxy app:8080/);
  });
});
