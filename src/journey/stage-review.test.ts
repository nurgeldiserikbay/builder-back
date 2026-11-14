import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixInstruction, reviewStage, uncoveredBlocking } from './stage-review.js';
import { buildReviewPrompt, normalizeAiReview } from './stage-ai.js';
import { stageDefinitions } from './catalog.js';
import { templateProcess, type BusinessProcess } from './process.js';
import { templateFeatures, templateScreens, type AppFeatures, type AppScreens } from './webapp.js';
import { templateContent, type Brief } from './artifacts.js';
import { templateSitemap } from './sitemap.js';
import { templateSchedule } from './schedule.js';
import { templateCatalog } from './products.js';

const brief: Brief = {
  businessName: 'Торты от Айгерим', whatYouDo: 'Печём торты на заказ к праздникам', audience: 'Родители и компании', city: null,
  mainAction: 'message', phone: null, messenger: '@aigerim', email: null, address: null, tone: 'friendly',
};
const ids = (type: string, content: unknown, features?: AppFeatures, process?: BusinessProcess) => reviewStage(type, content, { features, process }).findings.map((finding) => finding.id);

describe('stage review', () => {
  it('drafts made without AI pass the review', () => {
    for (const type of ['landing', 'company_site', 'store', 'booking', 'web_app']) assert.deepEqual(ids('process', templateProcess(type, brief)), [], type);
    const process = templateProcess('web_app', brief);
    const features = templateFeatures(brief, process);
    assert.deepEqual(ids('features', features, undefined, process), []);
    // The template says which data each feature works with: every record of the process is used.
    assert.ok(features.features.every((feature) => feature.data.length > 0), JSON.stringify(features.features.map((feature) => [feature.key, feature.data])));
    assert.deepEqual(ids('screens', templateScreens(features), features), []);
  });

  it('finds logic gaps in the business process', () => {
    const process: BusinessProcess = {
      actors: [{ key: 'client', name: 'Клиент', kind: 'client' }, { key: 'owner', name: 'Владелец', kind: 'business' }, { key: 'courier', name: 'Курьер', kind: 'staff' }],
      scenarios: [{ key: 's1', title: 'Заказ', goal: '', steps: [{ key: 'a', actor: 'client', action: 'Пишет', capability: 'contact' }, { key: 'b', actor: 'ghost', action: 'Отвечает', capability: 'other' }] }],
      rules: ['Принимаем заказы за день'],
      data: [
        { key: 'order', name: 'Заказ', fields: ['Дата', 'Сумма'], links: [{ to: 'nowhere', kind: 'one', label: '' }] },
        { key: 'client', name: 'Клиент', fields: ['Имя', 'Телефон'], links: [] },
      ],
    };
    const review = reviewStage('process', process);
    const found = review.findings.map((finding) => finding.id);
    for (const id of ['PROCESS_STEP_UNKNOWN_ACTOR:s1', 'PROCESS_ACTOR_IDLE:owner', 'PROCESS_ACTOR_IDLE:courier', 'PROCESS_SCENARIO_NO_RESULT:s1', 'PROCESS_LINK_UNKNOWN:order', 'PROCESS_ENTITY_ISOLATED:client', 'PROCESS_PERSONAL_DATA_NO_RULE:rules']) assert.ok(found.includes(id), id);
    // Blocking first, then important, then minor; the score falls with each finding.
    assert.equal(review.findings[0]!.severity, 'blocking');
    assert.equal(review.blocking, 3);
    assert.ok(review.score < 50);
    // A consent rule closes the security finding.
    const fixed = reviewStage('process', { ...process, rules: ['Контакты храним с согласия клиента и удаляем по просьбе'] });
    assert.ok(!fixed.findings.some((finding) => finding.code === 'PROCESS_PERSONAL_DATA_NO_RULE'));
  });

  it('asks for payment confirmation when there is online payment', () => {
    const process = templateProcess('store', brief);
    const paying = { ...process, rules: ['Контакты храним с согласия клиента'], scenarios: [{ key: 'pay', title: 'Оплата', goal: 'Заказ оплачен', steps: [{ key: 'a', actor: 'client', action: 'Платит картой', capability: 'pay_online' as const }, { key: 'b', actor: 'client', action: 'Ждёт', capability: 'other' as const }] }] };
    assert.ok(ids('process', paying).includes('PROCESS_PAYMENT_NO_CONFIRM:pay'));
    const confirmed = { ...paying, rules: [...paying.rules, 'Деньги возвращаем при отмене заказа'] };
    assert.ok(!ids('process', confirmed).includes('PROCESS_PAYMENT_NO_CONFIRM:pay'));
  });

  it('checks roles, privacy and access in the features', () => {
    const features: AppFeatures = {
      roles: [{ key: 'user', name: 'Клиент', description: '' }, { key: 'admin', name: 'Администратор', description: '' }, { key: 'guest', name: 'Гость', description: '' }],
      features: [{ key: 'orders', title: 'Заказы', description: 'Список заказов', roles: ['user', 'boss'], priority: 'must', acceptance: ['Работает'], data: [] }],
      sensitivity: 'personal', integrations: [],
    };
    const found = ids('features', features);
    for (const id of ['FEATURES_UNKNOWN_ROLE:orders', 'FEATURES_ROLE_IDLE:admin', 'FEATURES_ROLE_IDLE:guest', 'FEATURES_PERSONAL_NO_PRIVACY:sensitivity', 'FEATURES_NO_ACCESS_RULE:features', 'FEATURES_ACCEPTANCE_VAGUE:orders']) assert.ok(found.includes(id), id);
    assert.ok(ids('features', { ...features, sensitivity: 'payments' }).includes('FEATURES_PAYMENT_NO_CONFIRM:sensitivity'));
  });

  it('finds unreachable screens, broken links and links to another role', () => {
    const screens: AppScreens = { screens: [
      { key: 'home', title: 'Главная', role: 'user', purpose: '', features: [], blocks: [{ kind: 'form', title: 'Заявка', fields: [] }], links: ['list', 'admin_home', 'gone'] },
      { key: 'list', title: 'Список', role: 'user', purpose: '', features: ['unknown'], blocks: [{ kind: 'list', title: '', fields: ['a'] }], links: [] },
      { key: 'lost', title: 'Потерянный', role: 'user', purpose: '', features: [], blocks: [{ kind: 'text', title: '', fields: [] }], links: [] },
      { key: 'admin_home', title: 'Админка', role: 'admin', purpose: '', features: [], blocks: [{ kind: 'text', title: '', fields: [] }], links: [] },
    ] };
    const features: AppFeatures = { roles: [], features: [{ key: 'f', title: 'F', description: '', roles: [], priority: 'must', acceptance: [], data: [] }], sensitivity: 'normal', integrations: [] };
    const found = ids('screens', screens, features);
    for (const id of ['SCREENS_LINK_UNKNOWN:home', 'SCREENS_CROSS_ROLE_LINK:home', 'SCREENS_FORM_NO_FIELDS:home', 'SCREENS_UNREACHABLE:lost', 'SCREENS_UNKNOWN_FEATURE:list']) assert.ok(found.includes(id), id);
    assert.ok(!found.includes('SCREENS_UNREACHABLE:list'));
  });

  it('keeps finding ids stable and unique, and covers blockers only by their own ids', () => {
    const features: AppFeatures = { roles: [{ key: 'user', name: 'Клиент', description: '' }], features: [{ key: 'a', title: 'A', description: '', roles: ['x', 'y'], priority: 'should', acceptance: ['Длинный понятный критерий приёмки'], data: [] }], sensitivity: 'personal', integrations: [] };
    const first = reviewStage('features', features);
    assert.deepEqual(first, reviewStage('features', features));
    assert.equal(new Set(first.findings.map((finding) => finding.id)).size, first.findings.length);
    const blockers = first.findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.id);
    assert.equal(uncoveredBlocking(first, blockers.slice(0, 1)).length, blockers.length - 1);
    assert.equal(uncoveredBlocking(first, blockers).length, 0);
  });

  it('builds the AI instruction from finding texts only', () => {
    const review = reviewStage('features', { roles: [{ key: 'u', name: 'Клиент', description: '' }, { key: 'v', name: 'Гость', description: '' }], features: [{ key: 'a', title: 'A', description: '', roles: ['u'], priority: 'should', acceptance: ['Каждый видит только то, что разрешено его роли'], data: [] }], sensitivity: 'normal', integrations: [] });
    const text = fixInstruction(review.findings);
    assert.match(text, /Исправь только эти замечания/);
    assert.match(text, /Роль «Гость»/);
    assert.ok(text.length <= 1000);
    const many = Array.from({ length: 30 }, (_, i) => ({ ...review.findings[0]!, id: `x${i}` }));
    assert.ok(fixInstruction(many).length <= 1000);
    assert.match(fixInstruction(many), /\n1\. /);
  });

  it('gives types without rules the full score', () => {
    assert.deepEqual(reviewStage('design', { palette: 'forest' }), { rulesVersion: '1.2.0', score: 100, findings: [], blocking: 0 });
  });

  it('checks the site map, texts, schedule, catalog and architecture', () => {
    const map = { pages: [
      { key: 'home', path: '/', title: 'Главная', purpose: '', sections: ['about' as const] },
      { key: 'a', path: '/a', title: 'Услуги', purpose: 'Что делаем', sections: ['services' as const] },
      { key: 'b', path: '/b', title: 'услуги', purpose: 'Цены', sections: ['contacts' as const] },
    ] };
    const found = ids('sitemap', map);
    for (const id of ['SITEMAP_DUPLICATE_TITLE:a', 'SITEMAP_DUPLICATE_TITLE:b', 'SITEMAP_NO_PURPOSE:home', 'SITEMAP_HOME_NO_HERO:home', 'SITEMAP_NO_CALL_TO_ACTION:pages']) assert.ok(found.includes(id), id);

    const content = { sections: [
      { key: 'hero', type: 'hero' as const, title: 'Торты', text: 'Коротко', items: [], buttonLabel: '', imageId: null },
      { key: 'faq', type: 'faq' as const, title: 'Вопросы', text: '', items: [{ title: 'Как заказать?', text: 'Напишите' }], buttonLabel: null, imageId: null },
    ], seo: { title: 'x'.repeat(61), description: '' } };
    const texts = ids('content', content);
    for (const id of ['CONTENT_NO_BUTTON:hero', 'CONTENT_TEXT_THIN:hero', 'CONTENT_ONE_ITEM:faq', 'CONTENT_SEO_TITLE_LONG:seo', 'CONTENT_SEO_NO_DESCRIPTION:seo']) assert.ok(texts.includes(id), id);

    const schedule = { timezone: 'Asia/Almaty', services: [{ name: 'Стрижка', minutes: 30 }], masters: [{ key: 'm1', name: 'Айдана', services: ['Окрашивание'], week: [null, null, null, null, null, null, null] }],
      rules: { slotStep: 60, minNoticeHours: 72, horizonDays: 3, cancelHours: 100 } };
    const slots = ids('schedule', schedule);
    for (const id of ['SCHEDULE_MASTER_UNKNOWN_SERVICE:m1', 'SCHEDULE_NO_BOOKABLE_DAYS:rules', 'SCHEDULE_CANCEL_NEVER:rules', 'SCHEDULE_STEP_TOO_LONG:rules']) assert.ok(slots.includes(id), id);
    assert.equal(reviewStage('schedule', schedule).findings[0]!.severity, 'blocking');

    const catalog = { products: [
      { key: 'p1', name: 'Торт', description: '', price: 100, unit: null, available: true, imageId: null },
      { key: 'p2', name: 'торт', description: '', price: 200, unit: null, available: true, imageId: null },
    ], delivery: [], payment: { onDelivery: false, transfer: true, transferNote: '' }, minOrder: 50_000 };
    const shop = ids('catalog', catalog);
    for (const id of ['CATALOG_DUPLICATE_NAME:p1', 'CATALOG_TRANSFER_NO_NOTE:payment', 'CATALOG_NO_PHOTOS:products', 'CATALOG_MIN_ORDER_HIGH:minOrder']) assert.ok(shop.includes(id), id);

    const plan = { planVersion: '1', kind: 'site', summary: '', components: [], features: [], sequences: [],
      dataModel: [{ key: 'lead', name: 'Заявка', plain: '', fields: [], links: [{ to: 'ghost', kind: 'one', label: '' }] }],
      coverage: [{ scenario: 'Заказ', actor: 'Клиент', action: 'Платит онлайн', capability: 'pay_online', status: 'not_built', how: '' }] };
    assert.deepEqual(ids('techplan', plan), ['TECHPLAN_LINK_UNKNOWN:lead', 'TECHPLAN_STEPS_NOT_BUILT:coverage']);
    // A plan saved before the data model existed is not reviewed.
    assert.deepEqual(ids('techplan', { ownerNotes: null }), []);
  });

  it('drafts of the other stages have no blocking findings', () => {
    const offer = { services: [{ name: 'Торт', description: 'Бисквит', price: '15000' }], hours: null };
    const map = templateSitemap(brief, offer);
    assert.deepEqual(ids('sitemap', map), []);
    assert.equal(reviewStage('content', templateContent(brief, offer, map)).blocking, 0);
    assert.deepEqual(ids('schedule', templateSchedule(offer)), []);
    assert.equal(reviewStage('catalog', templateCatalog(offer)).blocking, 0);
  });

  it('checks that features name existing data and every record is used', () => {
    const process = templateProcess('web_app', brief);
    const base = templateFeatures(brief, process);
    const wrong = { ...base, features: base.features.map((feature, i) => (i === 0 ? { ...feature, data: ['ghost'] } : { ...feature, data: feature.data.filter(() => false) })) };
    const found = ids('features', wrong, undefined, process);
    assert.ok(found.includes(`FEATURES_UNKNOWN_DATA:${base.features[0]!.key}`));
    for (const entity of process.data) assert.ok(found.includes(`FEATURES_DATA_UNUSED:${entity.key}`), entity.key);
    // Results made before features named their data get no «unused» findings.
    const old = { ...base, features: base.features.map((feature) => ({ ...feature, data: [] })) };
    assert.ok(!ids('features', old, undefined, process).some((id) => id.startsWith('FEATURES_DATA_UNUSED')));
  });

  it('keeps AI advice plain, bounded and never blocking', () => {
    assert.throws(() => normalizeAiReview({ nope: 1 }, []), /AI_INVALID_RESPONSE/);
    const many = Array.from({ length: 15 }, () => ({ severity: 'blocking', category: 'weird', target: 'x', where: 'Где\u0007-то '.repeat(20), message: 'Достаточно длинное сообщение\nс переносом', fix: 'Сделать так' }));
    const out = normalizeAiReview({ findings: many }, ['y']);
    assert.equal(out.length, 10);
    assert.ok(out.every((finding) => finding.severity === 'minor' && finding.category === 'logic' && finding.target === null && finding.where.length <= 80 && !/[\u0000-\u001f]/.test(finding.message)));
    assert.deepEqual(out.slice(0, 2).map((finding) => finding.id), ['AI_REVIEW:1', 'AI_REVIEW:2']);
    const prompt = buildReviewPrompt({ stage: stageDefinitions.process, locale: 'ru', projectTypeTitle: 'Сайт', inputs: {}, current: { rules: [] }, ruleFindings: ['Правила: нет согласия'], targets: ['rules'] });
    assert.match(prompt.system, /Do not repeat findings listed in ruleFindings/);
    assert.match(prompt.system, /Russian/);
    assert.deepEqual(JSON.parse(prompt.user).ruleFindings, ['Правила: нет согласия']);
  });
});
