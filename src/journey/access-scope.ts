// Fine-grained access of a specialist to a project (STAGE_WORK_MODEL §7.2).
//
// By default a specialist — and the AI they direct — sees the accepted inputs of their stage and the stage itself.
// The owner can widen or narrow that per assignment:
// - extraReadStages: more accepted results to read (read-only, accepted version only; drafts and discussions stay closed);
// - hiddenParts: parts of what the specialist sees that are replaced with «скрыто владельцем» for them and their AI;
// - allowDownload: whether the specialist may download stage files other people uploaded;
// - readDays: how long the specialist can still look at the stage after it is accepted (0–30 days).
// The scope is checked on the server on every request; the AI receives exactly what the specialist sees.

import { BadRequestException } from '@nestjs/common';
import { tr } from '../i18n/i18n.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import type { Brief, Offer } from './artifacts.js';
import type { Catalog } from './products.js';

export const HIDDEN_MARK = 'скрыто владельцем';
export const READ_DAYS_DEFAULT = 7;
export const READ_DAYS_MAX = 30;
const EXTRA_MAX = 10;

/** Parts that can be hidden, by the stage whose artifact holds them. */
export const HIDEABLE_PARTS = {
  'goal.contacts': { stage: 'goal', title: 'Контакты владельца: телефон, мессенджер, почта, адрес' },
  'offer.prices': { stage: 'offer', title: 'Цены услуг' },
  'products.prices': { stage: 'products', title: 'Цены товаров и доставки' },
} as const satisfies Record<string, { stage: StageKey; title: string }>;
export type HiddenPart = keyof typeof HIDEABLE_PARTS;

export interface AccessScope { extraReadStages: StageKey[]; hiddenParts: HiddenPart[]; allowDownload: boolean; readDays: number }
export const DEFAULT_SCOPE: AccessScope = { extraReadStages: [], hiddenParts: [], allowDownload: false, readDays: READ_DAYS_DEFAULT };

/**
 * Parts a stage copies into its own result, so it has to see them as they are:
 * a build renders contacts and prices onto the site; texts list the services with their prices.
 */
const NEEDS_EVERYTHING = new Set(['site', 'handoff', 'techplan']);
const CONSUMES: Partial<Record<StageKey, HiddenPart[]>> = { content: ['offer.prices', 'products.prices'] };

/**
 * Validates an access scope for an assignment on `stageKey`.
 * inputs: the stage's accepted inputs (always visible); route: the project's route.
 * Missing fields keep `base` (the current scope, or the defaults for a new invitation).
 */
export function parseScope(raw: unknown, ctx: { route: StageKey[]; stageKey: StageKey; inputs: StageKey[] }, base: AccessScope = DEFAULT_SCOPE): AccessScope {
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('ACCESS_SCOPE_INVALID');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!['extraReadStages', 'hiddenParts', 'allowDownload', 'readDays'].includes(key)) throw new BadRequestException('ACCESS_SCOPE_INVALID');

  let extraReadStages = base.extraReadStages;
  if (input.extraReadStages !== undefined) {
    if (!Array.isArray(input.extraReadStages) || input.extraReadStages.length > EXTRA_MAX || input.extraReadStages.some((item) => typeof item !== 'string')) throw new BadRequestException('ACCESS_EXTRA_STAGES_INVALID');
    const wanted = [...new Set(input.extraReadStages as string[])];
    if (wanted.some((key) => !ctx.route.includes(key as StageKey) || key === ctx.stageKey)) throw new BadRequestException('ACCESS_EXTRA_STAGES_INVALID');
    // Inputs are visible anyway; keep only real additions, in route order.
    extraReadStages = ctx.route.filter((key) => wanted.includes(key) && !ctx.inputs.includes(key));
  }

  let hiddenParts = base.hiddenParts;
  if (input.hiddenParts !== undefined) {
    if (!Array.isArray(input.hiddenParts) || input.hiddenParts.some((item) => typeof item !== 'string' || !(item in HIDEABLE_PARTS))) throw new BadRequestException('ACCESS_HIDDEN_PARTS_INVALID');
    hiddenParts = [...new Set(input.hiddenParts as HiddenPart[])];
  }
  const visible = new Set<StageKey>([...ctx.inputs, ...extraReadStages]);
  // Hiding only makes sense for something the specialist would see; a build needs every detail to render the site.
  hiddenParts = hiddenParts.filter((part) => visible.has(HIDEABLE_PARTS[part].stage));
  if (hiddenParts.length && NEEDS_EVERYTHING.has(stageDefinitions[ctx.stageKey].artifactType)) throw new BadRequestException('ACCESS_HIDE_NOT_FOR_BUILD');
  if (hiddenParts.some((part) => CONSUMES[ctx.stageKey]?.includes(part))) throw new BadRequestException('ACCESS_HIDE_USED_BY_STAGE');

  let allowDownload = base.allowDownload;
  if (input.allowDownload !== undefined) {
    if (typeof input.allowDownload !== 'boolean') throw new BadRequestException('ACCESS_SCOPE_INVALID');
    allowDownload = input.allowDownload;
  }
  let readDays = base.readDays;
  if (input.readDays !== undefined) {
    if (!Number.isInteger(input.readDays) || (input.readDays as number) < 0 || (input.readDays as number) > READ_DAYS_MAX) throw new BadRequestException('ACCESS_READ_DAYS_INVALID');
    readDays = input.readDays as number;
  }
  return { extraReadStages, hiddenParts, allowDownload, readDays };
}

/** The scope stored on an assignment row. */
export function scopeOf(row: { extraReadStages: string[]; hiddenParts: string[]; allowDownload: boolean; readDays: number }): AccessScope {
  return {
    extraReadStages: row.extraReadStages.filter((key): key is StageKey => key in stageDefinitions),
    hiddenParts: row.hiddenParts.filter((part): part is HiddenPart => part in HIDEABLE_PARTS),
    allowDownload: row.allowDownload, readDays: row.readDays,
  };
}

/** What a specialist sees of an artifact: the hidden parts replaced. The original is never changed. */
export function redact(stageKey: string, content: unknown, hidden: readonly HiddenPart[]): unknown {
  if (!hidden.length || !content || typeof content !== 'object') return content;
  const mark = tr(HIDDEN_MARK);
  if (stageKey === 'goal' && hidden.includes('goal.contacts')) {
    const brief = content as Brief;
    const blank = (value: string | null) => (value ? mark : null);
    return { ...brief, phone: blank(brief.phone), messenger: blank(brief.messenger), email: blank(brief.email), address: blank(brief.address) };
  }
  if (stageKey === 'offer' && hidden.includes('offer.prices')) {
    const offer = content as Offer;
    return { ...offer, services: offer.services.map((service) => ({ ...service, price: service.price ? mark : null })) };
  }
  if (stageKey === 'products' && hidden.includes('products.prices')) {
    // Numbers stay numbers so the shape is unchanged; 0 with a note is what the specialist and their AI see.
    const catalog = content as Catalog;
    return { ...catalog, hiddenPrices: mark, minOrder: null, products: catalog.products.map((product) => ({ ...product, price: 0 })), delivery: catalog.delivery.map((option) => ({ ...option, price: 0 })) };
  }
  return content;
}

/** Parts the owner may hide for an assignment on `stageKey` (for the invitation form). */
export function hideableFor(stageKey: StageKey, visible: StageKey[]): HiddenPart[] {
  if (NEEDS_EVERYTHING.has(stageDefinitions[stageKey].artifactType)) return [];
  return (Object.keys(HIDEABLE_PARTS) as HiddenPart[]).filter((part) => visible.includes(HIDEABLE_PARTS[part].stage) && !CONSUMES[stageKey]?.includes(part));
}

/** Plain lines for the owner before inviting and for the specialist before accepting. */
export function scopeLines(scope: AccessScope): { can: string[]; cannot: string[]; afterAcceptance: string } {
  const can: string[] = [];
  const cannot: string[] = [];
  if (scope.extraReadStages.length) can.push(tr('Читать принятые результаты: {0}', [scope.extraReadStages.map((key) => `«${tr(stageDefinitions[key].title)}»`).join(', ')]));
  for (const part of scope.hiddenParts) cannot.push(tr('Видеть: {0} — вместо них «{1}»', [tr(HIDEABLE_PARTS[part].title).toLowerCase(), tr(HIDDEN_MARK)]));
  (scope.allowDownload ? can : cannot).push(tr('Скачивать файлы этапа, загруженные другими'));
  const afterAcceptance = scope.readDays === 0
    ? tr('Когда этап примут, доступ закроется сразу.')
    : tr('Когда этап примут, менять его будет нельзя; смотреть можно ещё {0} дн.', [scope.readDays]);
  return { can, cannot, afterAcceptance };
}
