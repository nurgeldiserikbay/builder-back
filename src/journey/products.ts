// «Каталог товаров» (stage key products): what the store sells, delivery options and how clients pay.
// The published store, the cart and the orders are built from the accepted version only.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError, type Offer } from './artifacts.js';

export interface Product { key: string; name: string; description: string; price: number; unit: string | null; available: boolean; imageId: string | null }
export interface DeliveryOption { key: string; title: string; price: number; needsAddress: boolean; note: string }
/** Payment the store accepts. Online payment is not offered on BuildPath stores yet. */
export interface StorePayment { onDelivery: boolean; transfer: boolean; transferNote: string }
export interface Catalog { products: Product[]; delivery: DeliveryOption[]; payment: StorePayment; minOrder: number | null }

export const CATALOG_LIMITS = { products: 60, delivery: 5, maxPrice: 10_000_000, cartLines: 30, quantity: 99 } as const;
const KEY = /^[a-z][a-z0-9-]{0,23}$/;
const IMAGE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return clean;
}
/** Whole tenge; «8 000», «8000 ₸» and 8000 are the same price. */
function price(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[^\d.,]/g, '').replace(',', '.')) : 0;
  if (!Number.isFinite(number) || number < 0 || number > CATALOG_LIMITS.maxPrice) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  return Math.round(number);
}
function keyOf(value: unknown, prefix: string, index: number, used: Set<string>): string {
  let key = typeof value === 'string' && KEY.test(value) && !used.has(value) ? value : `${prefix}${index + 1}`;
  while (used.has(key)) key = `${key}x`.slice(0, 24);
  used.add(key);
  return key;
}

export function normalizeCatalog(raw: unknown): Catalog {
  if (!isRecord(raw) || !Array.isArray(raw.products)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  if (raw.products.length > CATALOG_LIMITS.products) throw new ArtifactValidationError('FIELD_COUNT:products');
  const productKeys = new Set<string>();
  const products = raw.products.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:products.${index}`);
    return {
      key: keyOf(item.key, 'p', index, productKeys),
      name: text(item.name, `products.${index}.name`, 80),
      description: text(item.description, `products.${index}.description`, 300),
      price: price(item.price, `products.${index}.price`),
      unit: text(item.unit, `products.${index}.unit`, 12) || null,
      available: item.available !== false,
      imageId: typeof item.imageId === 'string' && IMAGE.test(item.imageId) ? item.imageId : null,
    };
  });
  const rawDelivery = Array.isArray(raw.delivery) ? raw.delivery : [];
  if (rawDelivery.length > CATALOG_LIMITS.delivery) throw new ArtifactValidationError('FIELD_COUNT:delivery');
  const deliveryKeys = new Set<string>();
  const delivery = rawDelivery.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:delivery.${index}`);
    return {
      key: keyOf(item.key, 'd', index, deliveryKeys),
      title: text(item.title, `delivery.${index}.title`, 60),
      price: price(item.price, `delivery.${index}.price`),
      needsAddress: item.needsAddress === true,
      note: text(item.note, `delivery.${index}.note`, 160),
    };
  });
  const pay = isRecord(raw.payment) ? raw.payment : {};
  const minOrder = raw.minOrder === null || raw.minOrder === undefined || raw.minOrder === '' ? null : price(raw.minOrder, 'minOrder') || null;
  return {
    products, delivery,
    payment: { onDelivery: pay.onDelivery !== false, transfer: pay.transfer === true, transferNote: text(pay.transferNote, 'payment.transferNote', 200) },
    minOrder,
  };
}

export interface CatalogIssue { key: string; message: string }

export function catalogIssues(catalog: Catalog): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  if (!catalog.products.some((product) => product.available)) issues.push({ key: 'products', message: tr('Добавьте хотя бы один товар в наличии.') });
  catalog.products.forEach((product, index) => {
    if (!product.name) issues.push({ key: product.key, message: tr('У товара {0} нет названия.', [index + 1]) });
    if (product.available && product.price <= 0) issues.push({ key: product.key, message: tr('Укажите цену товара «{0}».', [product.name || index + 1]) });
  });
  if (!catalog.delivery.length) issues.push({ key: 'delivery', message: tr('Добавьте способ получения: самовывоз или доставку.') });
  catalog.delivery.forEach((option, index) => { if (!option.title) issues.push({ key: option.key, message: tr('У способа получения {0} нет названия.', [index + 1]) }); });
  if (!catalog.payment.onDelivery && !catalog.payment.transfer) issues.push({ key: 'payment', message: tr('Выберите, как клиенты платят: при получении или переводом.') });
  return issues;
}

/** A start from the services list: every service becomes a product with its price when the price is a number. */
export function templateCatalog(offer: Offer | null): Catalog {
  const products = (offer?.services ?? []).slice(0, CATALOG_LIMITS.products).map((service, index) => {
    const digits = service.price?.replace(/[^\d]/g, '') ?? '';
    return { key: `p${index + 1}`, name: service.name, description: service.description ?? '', price: digits ? Math.min(Number(digits), CATALOG_LIMITS.maxPrice) : 0, unit: null, available: true, imageId: null };
  });
  return {
    products,
    delivery: [
      { key: 'pickup', title: tr('Самовывоз'), price: 0, needsAddress: false, note: tr('Заберёте сами — адрес пришлём после подтверждения.') },
      { key: 'courier', title: tr('Курьер по городу'), price: 0, needsAddress: true, note: tr('Привезём в течение дня после подтверждения.') },
    ],
    payment: { onDelivery: true, transfer: false, transferNote: '' },
    minOrder: null,
  };
}

export function catalogChanges(before: Catalog, after: Catalog): string[] {
  const changes: string[] = [];
  const old = new Map(before.products.map((product) => [product.key, product]));
  for (const product of after.products) {
    const was = old.get(product.key);
    if (!was) changes.push(tr('Добавлен товар «{0}»', [product.name]));
    else if (was.price !== product.price) changes.push(tr('Цена «{0}»: {1} → {2} ₸', [product.name, was.price, product.price]));
    else if (was.available !== product.available) changes.push(product.available ? tr('«{0}» снова в наличии', [product.name]) : tr('«{0}» больше не в наличии', [product.name]));
    else if (was.name !== product.name || was.description !== product.description) changes.push(tr('Изменено описание «{0}»', [product.name]));
  }
  for (const product of before.products) if (!after.products.some((item) => item.key === product.key)) changes.push(tr('Убран товар «{0}»', [product.name]));
  if (JSON.stringify(before.delivery) !== JSON.stringify(after.delivery)) changes.push(tr('Изменены способы получения'));
  if (JSON.stringify(before.payment) !== JSON.stringify(after.payment) || before.minOrder !== after.minOrder) changes.push(tr('Изменены условия оплаты или минимальный заказ'));
  return changes;
}

// --- Cart: kept in the page address (?i=key:2,other:1), so the store needs no cookies and no scripts ---

export interface CartLine { key: string; quantity: number }

export function parseCart(raw: string | null): CartLine[] {
  const lines: CartLine[] = [];
  for (const part of (raw ?? '').split(',').slice(0, CATALOG_LIMITS.cartLines)) {
    const match = /^([a-z][a-z0-9-]{0,23}):(\d{1,2})$/.exec(part.trim());
    if (!match) continue;
    const quantity = Math.min(Number(match[2]), CATALOG_LIMITS.quantity);
    if (quantity < 1) continue;
    const existing = lines.find((line) => line.key === match[1]);
    if (existing) existing.quantity = Math.min(existing.quantity + quantity, CATALOG_LIMITS.quantity);
    else lines.push({ key: match[1]!, quantity });
  }
  return lines;
}

export const cartParam = (lines: CartLine[]): string => lines.filter((line) => line.quantity > 0).map((line) => `${line.key}:${line.quantity}`).join(',');

/** Changes one line and returns the new cart; quantity 0 removes it. */
export function withLine(lines: CartLine[], key: string, quantity: number): CartLine[] {
  const next = lines.some((line) => line.key === key) ? lines.map((line) => (line.key === key ? { ...line, quantity } : line)) : [...lines, { key, quantity }];
  return next.filter((line) => line.quantity > 0).map((line) => ({ ...line, quantity: Math.min(line.quantity, CATALOG_LIMITS.quantity) }));
}

export interface PricedCart { lines: Array<{ key: string; name: string; unit: string | null; price: number; quantity: number; sum: number }>; itemsTotal: number; unavailable: string[] }

/** Prices come from the accepted catalogue only; lines for unknown or unavailable products are dropped and named. */
export function priceCart(catalog: Catalog, lines: CartLine[]): PricedCart {
  const result: PricedCart = { lines: [], itemsTotal: 0, unavailable: [] };
  for (const line of lines) {
    const product = catalog.products.find((item) => item.key === line.key);
    if (!product || !product.available || product.price <= 0) { if (product) result.unavailable.push(product.name); continue; }
    const sum = product.price * line.quantity;
    result.lines.push({ key: product.key, name: product.name, unit: product.unit, price: product.price, quantity: line.quantity, sum });
    result.itemsTotal += sum;
  }
  return result;
}

/** «8 000 ₸» — the currency of BuildPath stores is the tenge for now. */
export const tenge = (value: number): string => `${value.toLocaleString('ru-RU').replace(/ /g, ' ')} ₸`;
