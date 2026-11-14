// Rules of «Изменить сайт»: a small change to a live site without walking through the stages by hand.
import type { StageKey } from '../journey/catalog.js';
import { CATALOG_LIMITS, type Catalog } from '../journey/products.js';
import type { Schedule, WorkHours } from '../journey/schedule.js';

/**
 * Only stages whose sole dependent is the site build can be changed by a request in words: the change reaches the
 * site and nothing else has to be re-decided. Today these are the texts and the look. Products and the schedule
 * feed other stages too; only their prices, stock and working hours can be changed here, with a form (see below).
 */
export const QUICK_EDIT_STAGES: StageKey[] = ['content', 'design'];

/** Word starts only: «фон» must not match «телефон». \b does not work for Cyrillic in JavaScript, hence the lookbehind. */
const LOOK = /(?<![\p{L}\p{N}])(цвет|шрифт|фон|стил|оформлен|т[её]мн|светл|ярч|бледн|контраст|color|colour|font|style|dark|light|background|theme)/iu;

/** Which stage a request is about. The owner can switch it before sending. */
export function targetFor(request: string, route: StageKey[], override: string | null): StageKey | null {
  const allowed = QUICK_EDIT_STAGES.filter((key) => route.includes(key));
  if (override) return (allowed as string[]).includes(override) ? (override as StageKey) : null;
  if (LOOK.test(request) && allowed.includes('design')) return 'design';
  return allowed.includes('content') ? 'content' : allowed[0] ?? null;
}

export function checkRequest(raw: unknown): { ok: true; request: string } | { ok: false; code: string } {
  const value = typeof raw === 'string' ? raw.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim() : '';
  if (value.length < 5 || value.length > 1000) return { ok: false, code: 'QUICK_EDIT_REQUEST_INVALID' };
  return { ok: true, request: value };
}

/** The instruction given to the stage AI: the owner's words plus the guard that the rest stays as it is. */
export function instructionFor(request: string): string {
  return `${request}\n\nЭто правка уже опубликованного сайта: измени только то, о чём просят, остальное оставь как есть.`;
}

export const CONTACT_FIELDS = ['phone', 'messenger', 'email', 'address'] as const;
export type Contacts = Record<(typeof CONTACT_FIELDS)[number], string | null>;
const LIMITS: Record<(typeof CONTACT_FIELDS)[number], number> = { phone: 30, messenger: 60, email: 120, address: 160 };

/** New contacts from the form: empty means «remove», length limits as on the «Цель» stage. */
export function checkContacts(raw: unknown): { ok: true; contacts: Contacts } | { ok: false; code: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'INVALID_REQUEST_BODY' };
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(CONTACT_FIELDS as readonly string[]).includes(key))) return { ok: false, code: 'UNKNOWN_FIELD' };
  const contacts = {} as Contacts;
  for (const field of CONTACT_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== null && typeof value !== 'string') return { ok: false, code: `QUICK_EDIT_CONTACT_INVALID:${field}` };
    const clean = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    if (clean.length > LIMITS[field]) return { ok: false, code: `QUICK_EDIT_CONTACT_INVALID:${field}` };
    if (field === 'email' && clean && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(clean)) return { ok: false, code: 'QUICK_EDIT_CONTACT_INVALID:email' };
    if (field === 'phone' && clean && (clean.replace(/\D/g, '').length < 6 || /[^\d\s()+\-]/.test(clean))) return { ok: false, code: 'QUICK_EDIT_CONTACT_INVALID:phone' };
    contacts[field] = clean || null;
  }
  return { ok: true, contacts };
}

/** What will change, field by field, for the confirmation and the history. */
export function contactChanges(before: Partial<Contacts>, after: Contacts): Array<{ field: string; before: string | null; after: string | null }> {
  return CONTACT_FIELDS.filter((field) => (before[field] ?? null) !== after[field]).map((field) => ({ field, before: before[field] ?? null, after: after[field] }));
}


/**
 * Prices and stock of products already in the catalogue. Adding, removing or renaming a product changes what the
 * store is made of, so it is done on the «Каталог товаров» stage; here only price and «в наличии» change, by product key.
 */
export function checkProductEdits(raw: unknown, catalog: Catalog):
  { ok: true; catalog: Catalog; changes: Array<{ key: string; name: string; field: 'price' | 'available'; before: number | boolean; after: number | boolean }> } | { ok: false; code: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'products')) return { ok: false, code: 'INVALID_REQUEST_BODY' };
  const list = (raw as { products?: unknown }).products;
  if (!Array.isArray(list) || !list.length || list.length > CATALOG_LIMITS.products) return { ok: false, code: 'QUICK_EDIT_PRODUCTS_INVALID' };
  const edits = new Map<string, { price: number; available: boolean }>();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['key', 'price', 'available'].includes(key))) return { ok: false, code: 'QUICK_EDIT_PRODUCTS_INVALID' };
    const { key, price, available } = item as Record<string, unknown>;
    const product = catalog.products.find((entry) => entry.key === key);
    if (typeof key !== 'string' || !product || edits.has(key)) return { ok: false, code: 'QUICK_EDIT_PRODUCT_UNKNOWN' };
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > CATALOG_LIMITS.maxPrice) return { ok: false, code: `QUICK_EDIT_PRODUCT_PRICE_INVALID:${key}` };
    if (typeof available !== 'boolean') return { ok: false, code: 'QUICK_EDIT_PRODUCTS_INVALID' };
    edits.set(key, { price, available });
  }
  const changes: Array<{ key: string; name: string; field: 'price' | 'available'; before: number | boolean; after: number | boolean }> = [];
  const products = catalog.products.map((product) => {
    const edit = edits.get(product.key);
    if (!edit) return product;
    if (edit.price !== product.price) changes.push({ key: product.key, name: product.name, field: 'price', before: product.price, after: edit.price });
    if (edit.available !== product.available) changes.push({ key: product.key, name: product.name, field: 'available', before: product.available, after: edit.available });
    return { ...product, price: edit.price, available: edit.available };
  });
  return { ok: true, catalog: { ...catalog, products }, changes };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const sameDay = (a: WorkHours | null, b: WorkHours | null) => (a === null || b === null ? a === b : a.from === b.from && a.to === b.to);

/**
 * Working hours of the masters already in the schedule: Monday first, null is a day off. Masters, services and
 * booking rules are changed on the «Расписание и запись» stage.
 */
export function checkHoursEdits(raw: unknown, schedule: Schedule):
  { ok: true; schedule: Schedule; changes: Array<{ key: string; name: string; day: number; before: WorkHours | null; after: WorkHours | null }> } | { ok: false; code: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'masters')) return { ok: false, code: 'INVALID_REQUEST_BODY' };
  const list = (raw as { masters?: unknown }).masters;
  if (!Array.isArray(list) || !list.length || list.length > schedule.masters.length) return { ok: false, code: 'QUICK_EDIT_HOURS_INVALID' };
  const edits = new Map<string, Array<WorkHours | null>>();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['key', 'week'].includes(key))) return { ok: false, code: 'QUICK_EDIT_HOURS_INVALID' };
    const { key, week } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !schedule.masters.some((master) => master.key === key) || edits.has(key)) return { ok: false, code: 'QUICK_EDIT_MASTER_UNKNOWN' };
    if (!Array.isArray(week) || week.length !== 7) return { ok: false, code: `QUICK_EDIT_HOURS_INVALID:${key}` };
    const days: Array<WorkHours | null> = [];
    for (const day of week) {
      if (day === null) { days.push(null); continue; }
      const { from, to } = (day ?? {}) as Record<string, unknown>;
      if (!day || typeof day !== 'object' || Object.keys(day).some((field) => field !== 'from' && field !== 'to') || typeof from !== 'string' || typeof to !== 'string' || !TIME.test(from) || !TIME.test(to) || from >= to) return { ok: false, code: `QUICK_EDIT_HOURS_INVALID:${key}` };
      days.push({ from, to });
    }
    edits.set(key, days);
  }
  const changes: Array<{ key: string; name: string; day: number; before: WorkHours | null; after: WorkHours | null }> = [];
  const masters = schedule.masters.map((master) => {
    const week = edits.get(master.key);
    if (!week) return master;
    week.forEach((day, index) => { if (!sameDay(master.week[index] ?? null, day)) changes.push({ key: master.key, name: master.name, day: index, before: master.week[index] ?? null, after: day }); });
    return { ...master, week };
  });
  return { ok: true, schedule: { ...schedule, masters }, changes };
}
