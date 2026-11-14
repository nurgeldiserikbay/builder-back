import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingRequired, stageOutputs } from './stage-outputs.js';
import { templateProcess } from './process.js';
import { templateFeatures, templateScreens } from './webapp.js';
import { templateSitemap } from './sitemap.js';
import { templateSchedule } from './schedule.js';
import { templateCatalog } from './products.js';
import type { Brief } from './artifacts.js';

const brief: Brief = { businessName: 'Торты', whatYouDo: 'Печём торты', audience: 'Родители', city: null, mainAction: 'message', phone: null, messenger: '@a', email: null, address: null, tone: 'friendly' };
const missing = (type: Parameters<typeof stageOutputs>[0], content: unknown, context = {}) => missingRequired(stageOutputs(type, content, context)).map((item) => item.key);

describe('stage hand-over lists', () => {
  it('drafts made without AI hand over everything required', () => {
    for (const type of ['landing', 'company_site', 'store', 'booking', 'web_app']) assert.deepEqual(missing('process', templateProcess(type, brief)), [], type);
    const features = templateFeatures(brief, templateProcess('web_app', brief));
    assert.deepEqual(missing('features', features), []);
    assert.deepEqual(missing('screens', templateScreens(features), { features }), []);
    const offer = { services: [{ name: 'Торт', description: '', price: '15000' }], hours: null };
    assert.deepEqual(missing('sitemap', templateSitemap(brief, offer)), []);
    assert.deepEqual(missing('schedule', templateSchedule(offer)), []);
    assert.deepEqual(missing('catalog', templateCatalog(offer)), []);
    assert.deepEqual(missing('brief', brief), []);
  });

  it('names what the next stages would miss', () => {
    assert.deepEqual(missing('brief', { ...brief, mainAction: 'call', phone: null, audience: '' }), ['audience', 'action']);
    const process = templateProcess('landing', brief);
    assert.deepEqual(missing('process', { ...process, data: [{ key: 'x', name: 'Заказ', fields: [], links: [] }] }), ['data']);
    assert.deepEqual(missing('process', { ...process, actors: process.actors.filter((actor) => actor.kind === 'client') }), ['actors']);
    assert.deepEqual(missing('catalog', { products: [{ key: 'p', name: 'Торт', description: '', price: 0, unit: null, available: true, imageId: null }], delivery: [], payment: { onDelivery: false, transfer: false, transferNote: '' }, minOrder: null }), ['products', 'payment']);
    assert.deepEqual(missing('content', { sections: [{ key: 'h', type: 'hero', title: 'Торты [город]', text: '', items: [], buttonLabel: 'Заказать', imageId: null }], seo: { title: '', description: '' } }), ['blocks', 'placeholders', 'seo']);
    // Recommended items are listed but never required.
    const items = stageOutputs('offer', { services: [{ name: 'Торт', description: '', price: null }], hours: null });
    assert.deepEqual(items.map((item) => [item.key, item.level, item.met]), [['services', 'required', true], ['prices', 'recommended', false]]);
    assert.deepEqual(stageOutputs('site', { anything: 1 }), []);
  });
});
