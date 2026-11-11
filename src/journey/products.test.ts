import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArtifactValidationError, completenessIssues, importCatalogText, templateContent, type Brief } from './artifacts.js';
import { cartParam, catalogChanges, catalogIssues, normalizeCatalog, parseCart, priceCart, templateCatalog, withLine } from './products.js';
import { checkSite, renderSite, siteMeta } from './site-renderer.js';
import { buildTechPlan, coverageOf } from './techplan.js';
import { templateProcess } from './process.js';
import { projectTypes, routeInputs } from './catalog.js';
import { cartPage, orderPage, parseOrderForm } from '../sites/store-pages.js';

const brief: Brief = { businessName: 'Мыльня', whatYouDo: 'Мыло ручной работы', audience: 'Те, кто любит натуральное', city: 'Алматы', mainAction: 'message', phone: '+7 701 000 00 00', messenger: '@mylnya', email: null, address: null, tone: 'friendly' };
const catalog = normalizeCatalog({
  products: [
    { key: 'lavender', name: 'Лаванда', description: 'Успокаивающее', price: '2 500 ₸', available: true },
    { key: 'mint', name: 'Мята', price: 2200, unit: 'шт' },
    { key: 'gone', name: 'Роза', price: 3000, available: false },
  ],
  delivery: [{ key: 'pickup', title: 'Самовывоз', price: 0 }, { key: 'courier', title: 'Курьер', price: '1 000', needsAddress: true }],
  payment: { onDelivery: true, transfer: true, transferNote: 'Kaspi по номеру после подтверждения' },
  minOrder: 3000,
});
const design = { palette: 'berry', font: 'friendly', corners: 'rounded' as const, heroLayout: 'centered' as const };

describe('Каталог товаров', () => {
  it('reads prices written as text and refuses impossible ones', () => {
    assert.equal(catalog.products[0]!.price, 2500);
    assert.equal(catalog.delivery[1]!.price, 1000);
    assert.equal(catalog.minOrder, 3000);
    assert.throws(() => normalizeCatalog({ products: [{ name: 'X', price: -1 }] }), (error: unknown) => error instanceof ArtifactValidationError && error.code === 'FIELD_INVALID:products.0.price');
    assert.throws(() => normalizeCatalog({ products: Array.from({ length: 61 }, (_, index) => ({ name: `P${index}`, price: 1 })) }), /FIELD_COUNT:products/);
  });

  it('asks for a product in stock with a price, a delivery option and a way to pay', () => {
    assert.deepEqual(catalogIssues(catalog), []);
    const empty = normalizeCatalog({ products: [{ name: '', price: 0 }], delivery: [], payment: { onDelivery: false } });
    assert.deepEqual(catalogIssues(empty).map((issue) => issue.key), ['p1', 'p1', 'delivery', 'payment']);
    assert.deepEqual(completenessIssues('catalog', empty).length, 4);
  });

  it('imports a pasted product list and starts with the usual delivery', () => {
    const imported = importCatalogText('- Лаванда — 2 500\n- Мята — 2200 ₸\nПодарочный набор');
    assert.deepEqual(imported.products.map((product) => [product.name, product.price]), [['Лаванда', 2500], ['Мята', 2200], ['Подарочный набор', 0]]);
    assert.deepEqual(imported.delivery.map((option) => option.key), ['pickup', 'courier']);
    assert.deepEqual(templateCatalog({ services: [{ name: 'Торт', description: null, price: 'от 15 000 ₸/кг' }], hours: null }).products[0]!.price, 15000);
  });

  it('describes changes for the stages built on it', () => {
    const next = normalizeCatalog({ ...catalog, products: catalog.products.map((product) => (product.key === 'mint' ? { ...product, price: 2400 } : product.key === 'gone' ? { ...product, available: true } : product)) });
    assert.deepEqual(catalogChanges(catalog, next), ['Цена «Мята»: 2200 → 2400 ₸', '«Роза» снова в наличии']);
  });

  it('is part of the store route', () => {
    assert.deepEqual(projectTypes.store.stages, ['goal', 'process', 'products', 'techplan', 'content', 'design', 'build']);
    assert.deepEqual(routeInputs(projectTypes.store.stages, 'content'), ['goal', 'products']);
    assert.ok(routeInputs(projectTypes.store.stages, 'build').includes('products'));
  });
});

describe('Cart and order', () => {
  it('keeps the cart in the address and prices it from the catalogue only', () => {
    const lines = parseCart('lavender:2,mint:1,lavender:1,gone:1,nope:3,bad,mint:0');
    assert.deepEqual(lines, [{ key: 'lavender', quantity: 3 }, { key: 'mint', quantity: 1 }, { key: 'gone', quantity: 1 }, { key: 'nope', quantity: 3 }]);
    const priced = priceCart(catalog, lines);
    assert.equal(priced.itemsTotal, 3 * 2500 + 2200);
    assert.deepEqual(priced.unavailable, ['Роза']);
    assert.equal(cartParam(withLine(lines, 'mint', 0)), 'lavender:3,gone:1,nope:3');
    assert.equal(cartParam(withLine([], 'mint', 150)), 'mint:99');
  });

  it('validates the order form; prices or totals in the form are ignored', () => {
    const form = (extra: Record<string, string>) => new URLSearchParams({ i: 'lavender:2', delivery: 'pickup', payment: 'on_delivery', name: 'Аня', phone: '+7 701 111 22 33', consent: 'yes', price: '1', total: '1', ...extra }).toString();
    const ok = parseOrderForm(form({}), catalog);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.form, { lines: [{ key: 'lavender', quantity: 2 }], delivery: 'pickup', payment: 'on_delivery', name: 'Аня', phone: '+7 701 111 22 33', address: null, comment: null });
    const below = parseOrderForm(form({ i: 'mint:1' }), catalog);
    assert.equal(!below.ok && below.error, 'Минимальный заказ — 3 000 ₸.');
    const noAddress = parseOrderForm(form({ delivery: 'courier' }), catalog);
    assert.equal(!noAddress.ok && noAddress.error, 'Укажите адрес доставки.');
    const sold = parseOrderForm(form({ i: 'lavender:2,gone:1' }), catalog);
    assert.match(!sold.ok ? sold.error : '', /Роза/);
    const spam = parseOrderForm(form({ website: 'x' }), catalog);
    assert.equal(!spam.ok && spam.spam, true);
  });

  it('renders the storefront, the cart and the order page without scripts', () => {
    const content = templateContent(brief, null);
    const meta = siteMeta({ brief, offer: null, content, design, locale: 'ru', draft: false, store: catalog });
    const html = renderSite({ brief, offer: null, content, design, locale: 'ru', draft: false, store: catalog });
    assert.ok(html.includes('id="catalog"') && html.includes('href="/cart?i=lavender:1"') && html.includes('2 500 ₸') && html.includes('Нет в наличии: Роза.'));
    assert.ok(html.includes('href="#catalog"'), 'buttons lead to the catalogue');
    assert.ok(!html.includes('<script'));
    const preview = renderSite({ brief, offer: null, content, design, locale: 'ru', draft: true, store: catalog });
    assert.ok(!preview.includes('href="/cart'));
    const cart = cartPage(meta, catalog, 'lavender:2,gone:1');
    assert.ok(cart.includes('Больше нет в наличии: Роза') && cart.includes('href="/cart?i=lavender:1"') && cart.includes('href="/cart?i=lavender:3"') && cart.includes('name="i" value="lavender:2"'));
    assert.ok(cartPage(meta, catalog, 'mint:1').includes('Добавьте товаров ещё на 800 ₸'));
    assert.ok(!cartPage(meta, catalog, 'mint:1').includes('<form'));
    const order = orderPage(meta, { number: 7, items: [{ name: 'Лаванда', price: 2500, quantity: 2 }], itemsTiyn: 500_000, deliveryTitle: 'Самовывоз', deliveryTiyn: 0, totalTiyn: 500_000, paymentMethod: 'transfer', status: 'new', address: null, createdAt: new Date() }, 'x'.repeat(32), true, catalog.payment.transferNote);
    assert.ok(order.includes('Заказ №7 оформлен!') && order.includes('Итого: 5 000 ₸') && order.includes('Kaspi по номеру') && order.includes('Отменить заказ'));
    const checks = checkSite({ brief, offer: null, content, design, locale: 'ru', draft: false, store: catalog });
    assert.equal(checks.find((check) => check.id === 'store')?.status, 'passed');
    assert.equal(checks.find((check) => check.id === 'store-privacy')?.status, 'passed');
  });

  it('shows in the architecture what the store does and that it takes no online payment', () => {
    const process = templateProcess('store', brief);
    const plan = buildTechPlan({ projectType: 'store', brief, schedule: null, process, store: catalog }, null);
    assert.equal(plan.kind, 'store');
    assert.equal(plan.api, '');
    assert.deepEqual(plan.coverage?.filter((step) => step.status !== 'built').map((step) => step.capability), ['offline']);
    // On an ordinary site the same steps are honestly shown as not built.
    assert.equal(coverageOf('site', 'message', process).find((step) => step.capability === 'order')?.status, 'not_built');
    assert.ok(plan.limits.some((limit) => limit.includes('онлайн-оплаты')));
  });
});
