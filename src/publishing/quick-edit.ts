// Rules of «Изменить сайт»: a small change to a live site without walking through the stages by hand.
import type { StageKey } from '../journey/catalog.js';

/**
 * Only stages whose sole dependent is the site build can be changed this way: the change reaches the site and
 * nothing else has to be re-decided. Today these are the texts and the look. Services in a form, products and
 * the schedule feed other stages, so they are changed on their stage.
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
