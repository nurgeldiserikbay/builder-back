// Interface language of API responses. Platform texts are written in Russian; the English dictionary maps each Russian
// text to its translation. The language of a request comes from Accept-Language (the front sends the chosen one).
// Content the people of a project wrote or AI generated — stage results, sites — is never translated here.
import { AsyncLocalStorage } from 'node:async_hooks';
import { en } from './en.js';

export type Locale = 'ru' | 'en';
const store = new AsyncLocalStorage<Locale>();

export function localeFromHeader(header: string | undefined | null): Locale {
  const first = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'ru';
}

export const runWithLocale = <T>(locale: Locale, work: () => T): T => store.run(locale, work);
export const currentLocale = (): Locale => store.getStore() ?? 'ru';

/** Language of a project's own pages and messages to its clients. Kazakh has no platform dictionary yet, so it gets Russian. */
export const contentLocale = (value: string | null | undefined): Locale => (value === 'en' ? 'en' : 'ru');

function fill(text: string, vars?: unknown[] | Record<string, unknown>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = Array.isArray(vars) ? vars[Number(key)] : (vars as Record<string, unknown>)[key];
    return value === undefined ? whole : String(value);
  });
}

/** A message for someone else: a ready text, or a function that writes it in the language it is called in. */
export type Message = string | (() => string);
/** Writes a message in the recipient's language (account or project language). */
export const inLocale = (locale: string | null | undefined, message: Message): string => (typeof message === 'string' ? message : runWithLocale(contentLocale(locale), message));

/** An amount stored in tiyn, written for the current language: «12 500» or «12,500». */
export const money = (tiyn: number): string => (Math.round(tiyn) / 100).toLocaleString(currentLocale() === 'en' ? 'en-US' : 'ru-RU');

/** Text in the given language; {0} or {name} are filled from vars. */
export function trl(locale: Locale, text: string, vars?: unknown[] | Record<string, unknown>): string {
  return fill(locale === 'en' ? en[text] ?? text : text, vars);
}

/** Text in the language of the current request. */
export const tr = (text: string, vars?: unknown[] | Record<string, unknown>): string => trl(currentLocale(), text, vars);

/** Keys whose values are project content (stage results, previews, sites) and stay in the project's language. */
const CONTENT_KEYS = new Set(['content', 'preview', 'html', 'template', 'instruction', 'text_', 'ownerNotes']);

/** Replaces platform texts in a response with their translation; leaves project content as it is. */
export function localizeDeep<T>(value: T, locale: Locale): T {
  if (locale === 'ru') return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return en[item] ?? item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object' && !(item instanceof Date) && !Buffer.isBuffer(item)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) out[key] = CONTENT_KEYS.has(key) ? child : walk(child);
      return out;
    }
    return item;
  };
  return walk(value) as T;
}
