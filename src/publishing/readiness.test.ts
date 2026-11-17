import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Brief } from '../journey/artifacts.js';
import { normalizeProcess, templateProcess } from '../journey/process.js';
import { projectTypes } from '../journey/catalog.js';
import { templateFeatures } from '../journey/webapp.js';
import { launchReadiness, type ReadinessInput } from './readiness.js';

const brief: Brief = { businessName: 'Усы', whatYouDo: 'Мужские стрижки', audience: 'Мужчины', city: 'Алматы', mainAction: 'message', phone: null, messenger: null, email: null, address: null, tone: 'friendly' };
const base = (patch: Partial<ReadinessInput> = {}): ReadinessInput => ({
  projectType: 'booking', route: projectTypes.booking.stages, build: { accepted: true, qualityPassed: true }, brief, process: templateProcess('booking', brief),
  spec: { ...templateFeatures(brief, null, 'site'), questions: ['Брать ли предоплату?'] }, offer: { services: [{ name: 'Стрижка', description: null, price: null }], hours: null },
  channels: { telegram: 'not_linked', email: false }, lastTest: null, ...patch,
});
const status = (input: ReadinessInput) => Object.fromEntries(launchReadiness(input).checks.map((check) => [check.key, check.status]));

describe('launch readiness', () => {
  it('names everything a booking site still needs, with where to fix it', () => {
    assert.deepEqual(status(base()), { build: 'ok', contacts: 'warn', requests: 'warn', situations: 'warn', spec: 'warn', prices: 'warn', cancellation: 'warn' });
    const result = launchReadiness(base());
    assert.equal(result.blocking, false);
    assert.deepEqual(result.checks.find((check) => check.key === 'requests')?.fix, { publication: 'channels' });
    assert.deepEqual(result.checks.find((check) => check.key === 'prices')?.fix, { stageKey: 'offer' });
  });

  it('is all green once the business is ready; only the build blocks', () => {
    const process = normalizeProcess({ ...templateProcess('booking', brief), situations: [
      { key: 'who_answers', answer: 'owner' }, { key: 'booking_cancel', answer: 'hours_24' }, { key: 'no_show', answer: 'warn_then_prepay' }, { key: 'late', answer: 'wait_15' }, { key: 'master_absent', answer: 'offer_other' }, { key: 'reminder', answer: 'day_before' },
    ] });
    const ready = launchReadiness(base({ brief: { ...brief, phone: '+7 700 111 22 33' }, process, spec: templateFeatures(brief, process, 'site'), offer: { services: [{ name: 'Стрижка', description: null, price: '5 000 ₸' }], hours: null }, channels: { telegram: 'linked', email: true }, lastTest: { telegram: 'sent', email: 'off' } }));
    assert.equal(ready.ready, ready.total, JSON.stringify(ready.checks.filter((check) => check.status !== 'ok')));
    const unbuilt = launchReadiness(base({ build: { accepted: false, qualityPassed: false } }));
    assert.equal(unbuilt.blocking, true);
  });

  it('a test request that did not arrive asks to check and resend', () => {
    const check = launchReadiness(base({ channels: { telegram: 'linked', email: true }, lastTest: { telegram: 'failed', email: 'failed' } })).checks.find((item) => item.key === 'requests')!;
    assert.equal(check.status, 'warn');
    assert.deepEqual(check.fix, { publication: 'test' });
  });
});
