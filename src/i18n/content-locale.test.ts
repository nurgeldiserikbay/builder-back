import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentLocale, inLocale, money, runWithLocale, tr } from './i18n.js';
import type { Brief, Offer } from '../journey/artifacts.js';
import { templateContent } from '../journey/artifacts.js';
import { renderSite, siteMeta } from '../journey/site-renderer.js';
import { dayLabel, templateSchedule } from '../journey/schedule.js';
import { bookingPage, confirmPage, parseBookingForm, servicesPage } from '../sites/booking-pages.js';
import { messagePage, privacyPage } from '../sites/site-pages.js';
import { reminderEmail } from '../notifications/booking-reminders.js';
import { bookingText } from '../notifications/booking-notifier.js';
import { leadText } from '../notifications/lead-notifier.js';
import { completenessIssues, importContentText } from '../journey/artifacts.js';
import { templateProcess } from '../journey/process.js';
import { buildTechPlan, techPlanMarkdown } from '../journey/techplan.js';

const brief: Brief = { businessName: 'Lotus Nails', whatYouDo: 'Manicure in Almaty', audience: 'Women', city: 'Almaty', mainAction: 'form', phone: '+7 701 000 11 22', messenger: null, email: null, address: 'Abay 1', tone: 'friendly' };
const offer: Offer = { services: [{ name: 'Manicure', description: null, price: '5 000 ₸' }], hours: 'Mon–Sat 10–19' };
const design = { palette: 'forest', font: 'modern', corners: 'rounded' as const, heroLayout: 'centered' as const };
const booking = { schedule: templateSchedule(offer), prices: { Manicure: '5 000 ₸' } };
const at = (iso: string) => new Date(iso);
const CYRILLIC = /[А-Яа-яЁё]/;

describe('Project language of sites and messages', () => {
  it('maps project and account languages; Kazakh falls back to Russian', () => {
    assert.equal(contentLocale('en'), 'en');
    assert.equal(contentLocale('kk'), 'ru');
    assert.equal(contentLocale(null), 'ru');
    assert.equal(inLocale('en', () => tr('Онлайн-запись')), 'Online booking');
    assert.equal(inLocale('ru', () => tr('Онлайн-запись')), 'Онлайн-запись');
    assert.equal(runWithLocale('en', () => money(1_250_000)), '12,500');
  });

  it('renders the fixed texts of an English site in English, whatever language the owner uses', () => {
    const content = templateContent(brief, offer);
    const html = runWithLocale('ru', () => renderSite({ brief, offer, content, design, locale: 'en', draft: true, booking }));
    assert.match(html, /<html lang="en">/);
    for (const text of ['Online booking', 'Choose a time', 'Your name', 'Send request', 'Draft — not published', 'Phone']) assert.ok(html.includes(text), text);
    for (const text of ['Онлайн-запись', 'Отправить заявку', 'Черновик']) assert.ok(!html.includes(text), text);
    const meta = siteMeta({ brief, offer, content, design, locale: 'en', draft: false, booking });
    assert.deepEqual(meta.ownerContacts.map((item) => item.label), ['Phone', 'Address']);
  });

  it('keeps Russian sites in Russian', () => {
    const content = templateContent(brief, offer);
    const html = runWithLocale('en', () => renderSite({ brief, offer, content, design, locale: 'ru', draft: false, booking }));
    assert.ok(html.includes('Онлайн-запись') && html.includes('Отправить заявку'));
  });

  it('writes booking pages, dates and errors in the site language', () => {
    const meta = siteMeta({ brief, offer, content: templateContent(brief, offer), design, locale: 'en', draft: false, booking });
    runWithLocale('en', () => {
      assert.equal(dayLabel('2026-11-11'), 'Wed, 11 November');
      const services = servicesPage(meta, booking);
      assert.ok(services.includes('Step 1 of 3') && services.includes('Choose a service') && services.includes('1 h'));
      const confirm = confirmPage(meta, booking, { service: 0, master: 'any', start: at('2026-11-11T05:00:00Z') }, null, {}, true);
      assert.ok(confirm.includes('Wed, 11 November, 10:00') && confirm.includes('any available specialist') && confirm.includes('Email for a reminder (optional)'));
      const view = bookingPage(meta, { serviceName: 'Manicure', masterName: 'Aida', startsAt: at('2026-11-11T05:00:00Z'), minutes: 60, price: null, timezone: 'Asia/Almaty', status: 'booked', clientName: 'A' }, 'x'.repeat(32), true, 3, true);
      assert.ok(view.includes('You are booked!') && view.includes('Specialist: Aida'));
      const failed = parseBookingForm(new URLSearchParams({ s: '0', m: 'any', t: '2026-11-11T05:00:00.000Z', name: 'A', phone: '+77011112233' }).toString());
      assert.equal(!failed.ok && failed.error, 'To book, tick the consent to data processing.');
      const pages = [services, confirm, view, messagePage(meta, 'Страница не найдена', 'Такой страницы на сайте нет.'), privacyPage(meta, 365, true)];
      for (const page of pages) assert.ok(!CYRILLIC.test(page.replace(/Manicure|Lotus Nails/g, '')), page.slice(0, 120));
    });
  });

  it('writes the client reminder and the owner and master messages in their languages', () => {
    const mail = runWithLocale('en', () => reminderEmail({
      siteName: 'Lotus Nails', siteUrl: 'https://lotus.example', serviceName: 'Manicure', masterName: 'Aida', startsAt: at('2026-11-20T10:00:00Z'), timezone: 'Asia/Almaty',
      minutes: 60, price: null, clientName: 'Anna', cancelUrl: 'https://lotus.example/book/b/abc', canCancel: true, cancelHours: 3, contacts: [{ label: 'Телефон', value: '+7 700' }],
    }, at('2026-11-19T10:00:00Z')));
    assert.equal(mail.subject, 'Reminder: Lotus Nails, tomorrow at 15:00');
    assert.ok(mail.html.includes('Hello, Anna!') && mail.html.includes('Phone: +7 700') && !CYRILLIC.test(mail.html));
    const message = { kind: 'created' as const, siteName: 'Lotus Nails', projectId: 'p1', serviceName: 'Manicure', masterName: 'Aida', startsAt: at('2026-11-11T05:00:00Z'), timezone: 'Asia/Almaty', clientName: 'Anna', clientPhone: '+7701', comment: null };
    assert.equal(inLocale('en', () => bookingText(message, 'https://app.example', 'master')), 'New booking from the site «Lotus Nails»\nManicure — Wed, 11 November, 10:00\nSpecialist: Aida\nClient: Anna, +7701\nYour bookings: https://app.example/master');
    assert.match(inLocale('ru', () => bookingText(message, 'https://app.example')), /^Новая запись с сайта «Lotus Nails»\nManicure — Ср, 11 ноября, 10:00[\s\S]*Все записи:/);
    assert.match(inLocale('en', () => leadText({ name: 'Anna', contact: '+7701', message: null, siteName: 'Lotus Nails', projectId: 'p1' }, undefined)), /^New request from the site «Lotus Nails»\nName: Anna\nContact: \+7701$/);
  });

  it('writes templates, imports and the architecture of an English project in English', () => {
    runWithLocale('en', () => {
      const content = templateContent({ ...brief, businessName: '', audience: '' }, null);
      assert.equal(content.sections[0].title, '[add the business name]');
      assert.ok(content.sections.some((section) => section.title === 'Why clients choose us'));
      assert.ok(completenessIssues('content', content).some((issue) => issue.key === 'benefits'), 'English placeholders are still found');
      const imported = importContentText('Lotus Nails\nManicure in Almaty\n\nOur services\nManicure\n\nContacts\nCall us');
      assert.deepEqual(imported.sections.map((section) => section.type), ['hero', 'services', 'contacts']);
      assert.equal(imported.sections[0].buttonLabel, 'Contact us');
      const process = templateProcess('booking', brief);
      assert.deepEqual(process.scenarios.map((scenario) => scenario.title), ['Booking', 'Cancellation', 'Schedule change']);
      const plan = buildTechPlan({ projectType: 'booking', brief, schedule: booking.schedule, process }, null);
      const text = JSON.stringify({ ...plan, api: '' }).replace(/Lotus Nails|Manicure|Мастер|Asia\/Almaty/g, '');
      assert.ok(!CYRILLIC.test(text), text.match(/.{40}[А-Яа-яЁё].{40}/)?.[0]);
      assert.ok(!CYRILLIC.test(plan.api) && plan.api.includes('Online booking (BuildPath)') && plan.api.includes("description: 'Booking created: Location /book/b/{token}?new=1'"));
      assert.match(techPlanMarkdown(plan), /^# Architecture\n/);
      assert.ok(plan.coverage?.every((step) => !CYRILLIC.test(step.how)));
      const site = buildTechPlan({ projectType: 'landing', brief, schedule: null, process: templateProcess('landing', brief) }, null);
      assert.ok(!CYRILLIC.test(site.api) && site.api.includes("description: 'Phone, messenger or email'"));
    });
    const russian = buildTechPlan({ projectType: 'booking', brief, schedule: booking.schedule, process: null }, null);
    assert.match(russian.summary, /^Сайт «Lotus Nails» с онлайн-записью/);
  });
});
