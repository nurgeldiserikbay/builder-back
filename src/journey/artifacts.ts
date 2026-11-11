// Typed artifact schemas, deterministic validation, locking/merge rules, templates and text import.
import { tr } from '../i18n/i18n.js';
import { PLACEHOLDER } from './placeholder.js';
import { corners, fonts, heroLayouts, palettes } from './site-renderer.js';
import type { ArtifactType } from './catalog.js';
import { normalizeSchedule, scheduleIssues, type BookingConfig, type Schedule } from './schedule.js';
import { normalizeTechPlan } from './techplan.js';
import { normalizeProcess, processIssues, type BusinessProcess } from './process.js';
import { normalizeSitemap, sitemapIssues, type Sitemap } from './sitemap.js';

export type MainAction = 'call' | 'message' | 'visit' | 'email' | 'form';
export type Tone = 'friendly' | 'formal' | 'bold';

export interface Brief {
  businessName: string; whatYouDo: string; audience: string; city: string | null;
  mainAction: MainAction | null; phone: string | null; messenger: string | null; email: string | null; address: string | null; tone: Tone | null;
}
export interface OfferService { name: string; description: string | null; price: string | null }
export interface Offer { services: OfferService[]; hours: string | null }
export const sectionTypes = ['hero', 'about', 'services', 'benefits', 'steps', 'faq', 'contacts', 'cta'] as const;
export type SectionType = (typeof sectionTypes)[number];
export interface ContentItem { title: string; text: string }
/** page: key of the «Карта сайта» page the block is on (multi-page sites only; absent means the single page). */
export interface ContentSection { key: string; type: SectionType; title: string; text: string; items: ContentItem[]; buttonLabel: string | null; imageId: string | null; page?: string }
export interface PageSeo { page: string; title: string; description: string }
/** seo is for the home page; pageSeo holds the other pages of a multi-page site. */
export interface ContentArtifact { sections: ContentSection[]; seo: { title: string; description: string }; pageSeo?: PageSeo[] }
export interface DesignArtifact { palette: string; font: string; corners: 'rounded' | 'sharp'; heroLayout: 'centered' | 'left' }
export interface SiteMeta {
  businessName: string; locale: string; hasForm: boolean;
  theme: { background: string; text: string; muted: string; accent: string; accentText: string; font: string; radius: string };
  ownerContacts: Array<{ label: string; value: string }>;
  /** Online booking route: the accepted schedule this build was made from. */
  booking?: BookingConfig;
}
export interface SiteArtifact {
  html: string;
  /** Present for builds made after forms/publication were added (catalog 1.1.0). */
  meta?: SiteMeta;
  /** Multi-page sites: every page, «/» first; html is the home page. */
  pages?: Array<{ path: string; title: string; html: string }>;
  checks: Array<{ id: string; status: 'passed' | 'warning' | 'failed'; title: string; details: string; required: boolean }>;
  sourceVersionIds: Record<string, string>;
  compiledAt: string;
}

export const sectionTypeLabels: Record<SectionType, string> = {
  hero: 'Первый экран', about: 'О вас', services: 'Услуги', benefits: 'Преимущества', steps: 'Как это работает', faq: 'Частые вопросы', contacts: 'Контакты', cta: 'Призыв к действию',
};

export class ArtifactValidationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ArtifactValidationError'; }
}

/** Key-order independent JSON (PostgreSQL JSONB does not preserve object key order). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function str(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`);
    return null;
  }
  if (typeof value !== 'string') throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  const trimmed = value.replace(/\u0000/g, '').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  if (!trimmed) {
    if (required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`);
    return null;
  }
  return trimmed;
}
function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  return value as T;
}

/** Brief accepts partial drafts; completeness is checked separately at acceptance. */
export function normalizeBrief(raw: unknown): Brief {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  return {
    businessName: str(raw.businessName, 'businessName', 80, false) ?? '',
    whatYouDo: str(raw.whatYouDo, 'whatYouDo', 400, false) ?? '',
    audience: str(raw.audience, 'audience', 300, false) ?? '',
    city: str(raw.city, 'city', 80, false),
    mainAction: oneOf(raw.mainAction, 'mainAction', ['call', 'message', 'visit', 'email', 'form'] as const),
    phone: str(raw.phone, 'phone', 30, false),
    messenger: str(raw.messenger, 'messenger', 60, false),
    email: str(raw.email, 'email', 120, false),
    address: str(raw.address, 'address', 160, false),
    tone: oneOf(raw.tone, 'tone', ['friendly', 'formal', 'bold'] as const),
  };
}

export function normalizeOffer(raw: unknown): Offer {
  if (!isRecord(raw) || !Array.isArray(raw.services)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  if (raw.services.length > 12) throw new ArtifactValidationError('FIELD_TOO_MANY:services');
  const services = raw.services.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:services.${index}`);
    return {
      name: str(item.name, `services.${index}.name`, 80, true)!,
      description: str(item.description, `services.${index}.description`, 300, false),
      price: str(item.price, `services.${index}.price`, 40, false),
    };
  });
  return { services, hours: str(raw.hours, 'hours', 120, false) };
}

function imageIdOf(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  return value;
}

/** Photo ids used by a content artifact (for rendering and delete protection). */
export function contentImageIds(content: unknown): string[] {
  const sections = (content as Partial<ContentArtifact> | null)?.sections ?? [];
  return [...new Set(sections.map((section) => section.imageId).filter((id): id is string => Boolean(id)))];
}

export function normalizeContent(raw: unknown): ContentArtifact {
  if (!isRecord(raw) || !Array.isArray(raw.sections) || !isRecord(raw.seo)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const paged = raw.sections.some((section) => isRecord(section) && typeof section.page === 'string' && section.page !== '');
  // A multi-page site has up to 12 blocks per page and 7 pages.
  if (raw.sections.length < 1 || raw.sections.length > (paged ? 60 : 12)) throw new ArtifactValidationError('FIELD_COUNT:sections');
  const keys = new Set<string>();
  const sections = raw.sections.map((section, index) => {
    if (!isRecord(section)) throw new ArtifactValidationError(`FIELD_INVALID:sections.${index}`);
    const key = str(section.key, `sections.${index}.key`, 40, true)!;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(key) || keys.has(key)) throw new ArtifactValidationError(`FIELD_INVALID:sections.${index}.key`);
    keys.add(key);
    const items = section.items === undefined || section.items === null ? [] : section.items;
    if (!Array.isArray(items) || items.length > 12) throw new ArtifactValidationError(`FIELD_INVALID:sections.${index}.items`);
    return {
      key,
      type: oneOf(section.type, `sections.${index}.type`, sectionTypes) ?? (() => { throw new ArtifactValidationError(`FIELD_REQUIRED:sections.${index}.type`); })(),
      title: str(section.title, `sections.${index}.title`, 120, false) ?? '',
      text: str(section.text, `sections.${index}.text`, 1200, false) ?? '',
      items: items.map((item, itemIndex) => {
        if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:sections.${index}.items.${itemIndex}`);
        return { title: str(item.title, `sections.${index}.items.${itemIndex}.title`, 100, true)!, text: str(item.text, `sections.${index}.items.${itemIndex}.text`, 400, false) ?? '' };
      }),
      buttonLabel: str(section.buttonLabel, `sections.${index}.buttonLabel`, 40, false),
      imageId: imageIdOf(section.imageId, `sections.${index}.imageId`),
      ...(paged ? { page: typeof section.page === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(section.page) ? section.page : 'home' } : {}),
    };
  });
  if (paged) {
    const perPage = new Map<string, number>();
    for (const section of sections) perPage.set(section.page!, (perPage.get(section.page!) ?? 0) + 1);
    if ([...perPage.values()].some((count) => count > 12)) throw new ArtifactValidationError('FIELD_COUNT:sections');
  }
  const pageSeo = paged && Array.isArray(raw.pageSeo) ? raw.pageSeo.slice(0, 7).flatMap((item, index) => {
    if (!isRecord(item) || typeof item.page !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(item.page)) return [];
    return [{ page: item.page, title: str(item.title, `pageSeo.${index}.title`, 70, false) ?? '', description: str(item.description, `pageSeo.${index}.description`, 160, false) ?? '' }];
  }).filter((item, index, list) => list.findIndex((other) => other.page === item.page) === index) : [];
  return {
    sections,
    seo: { title: str(raw.seo.title, 'seo.title', 70, false) ?? '', description: str(raw.seo.description, 'seo.description', 160, false) ?? '' },
    ...(paged ? { pageSeo } : {}),
  };
}

export function normalizeDesign(raw: unknown): DesignArtifact {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const palette = oneOf(raw.palette, 'palette', palettes.map((item) => item.id));
  const font = oneOf(raw.font, 'font', fonts.map((item) => item.id));
  const corner = oneOf(raw.corners, 'corners', corners.map((item) => item.id));
  const heroLayout = oneOf(raw.heroLayout, 'heroLayout', heroLayouts.map((item) => item.id));
  if (!palette || !font || !corner || !heroLayout) throw new ArtifactValidationError('FIELD_REQUIRED:design');
  return { palette, font, corners: corner, heroLayout };
}

export function normalizeArtifact(type: ArtifactType, raw: unknown): unknown {
  switch (type) {
    case 'brief': return normalizeBrief(raw);
    case 'offer': return normalizeOffer(raw);
    case 'content': return normalizeContent(raw);
    case 'design': return normalizeDesign(raw);
    case 'schedule': return normalizeSchedule(raw);
    case 'techplan': return normalizeTechPlan(raw);
    case 'process': return normalizeProcess(raw);
    case 'sitemap': return normalizeSitemap(raw);
    default: throw new ArtifactValidationError('ARTIFACT_NOT_EDITABLE');
  }
}

/** Keys that can be locked against AI rewrites: brief/offer/design fields or content section keys. */
export function lockableKeys(type: ArtifactType, content: unknown): string[] {
  if (type === 'content') return (content as ContentArtifact).sections.map((section) => section.key).concat('seo', ...((content as ContentArtifact).pageSeo ? ['pageSeo'] : []));
  if (type === 'brief') return ['businessName', 'whatYouDo', 'audience', 'city', 'mainAction', 'phone', 'messenger', 'email', 'address', 'tone'];
  if (type === 'offer') return ['services', 'hours'];
  if (type === 'design') return ['palette', 'font', 'corners', 'heroLayout'];
  if (type === 'schedule') return ['timezone', 'services', 'masters', 'rules'];
  if (type === 'techplan') return ['ownerNotes'];
  if (type === 'process') return ['actors', 'scenarios', 'rules', 'data'];
  if (type === 'sitemap') return ['pages'];
  return [];
}

function valueAt(type: ArtifactType, content: unknown, key: string): unknown {
  if (!content) return undefined;
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    return key === 'seo' ? artifact.seo : key === 'pageSeo' ? artifact.pageSeo : artifact.sections.find((section) => section.key === key);
  }
  return (content as Record<string, unknown>)[key];
}

/** Keys whose value differs between two versions (used to lock manually edited parts). */
export function changedKeys(type: ArtifactType, before: unknown, after: unknown): string[] {
  const keys = new Set([...(before ? lockableKeys(type, before) : []), ...lockableKeys(type, after)]);
  // Choosing a photo is not a text edit: AI rewrites keep photos anyway, so a photo change must not lock the section's text.
  const comparable = (value: unknown) => {
    if (type !== 'content' || !value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
    const { imageId: _photo, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  return [...keys].filter((key) => stableStringify(comparable(valueAt(type, before, key))) !== stableStringify(comparable(valueAt(type, after, key)))
    && valueAt(type, after, key) !== undefined);
}

/**
 * Applies an AI proposal while keeping locked parts of the base version.
 * targetKey limits the change to one part; locked keys are kept unless they are the explicit target.
 */
export function mergeProposal(type: ArtifactType, base: unknown | null, proposal: unknown, lockedKeys: string[], targetKey: string | null): unknown {
  if (!base) return proposal;
  const keep = new Set(lockedKeys.filter((key) => key !== targetKey));
  if (type === 'content') {
    const baseContent = base as ContentArtifact;
    const next = proposal as ContentArtifact;
    const photoOf = (key: string) => baseContent.sections.find((section) => section.key === key)?.imageId ?? null;
    if (targetKey) {
      if (targetKey === 'seo') return { ...baseContent, seo: next.seo, ...(next.pageSeo ? { pageSeo: next.pageSeo } : {}) };
      const replacement = next.sections.find((section) => section.key === targetKey) ?? next.sections[0];
      if (!replacement) return baseContent;
      return { ...baseContent, sections: baseContent.sections.map((section) => (section.key === targetKey ? { ...replacement, key: targetKey, imageId: replacement.imageId ?? section.imageId ?? null, ...(section.page ? { page: section.page } : {}) } : section)) };
    }
    const proposedByKey = new Map(next.sections.map((section) => [section.key, section]));
    const sections: ContentSection[] = [];
    for (const section of next.sections) {
      const locked = baseContent.sections.find((item) => item.key === section.key && keep.has(item.key));
      sections.push(locked ?? { ...section, imageId: section.imageId ?? photoOf(section.key) });
    }
    // Locked sections are never dropped by a full regeneration.
    for (const section of baseContent.sections) {
      if (keep.has(section.key) && !proposedByKey.has(section.key)) sections.push(section);
    }
    const pageSeo = keep.has('pageSeo') ? baseContent.pageSeo : next.pageSeo ?? baseContent.pageSeo;
    return { sections: sections.slice(0, sections.some((section) => section.page) ? 60 : 12), seo: keep.has('seo') ? baseContent.seo : next.seo, ...(pageSeo ? { pageSeo } : {}) };
  }
  const baseRecord = base as Record<string, unknown>;
  const nextRecord = proposal as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseRecord };
  for (const key of lockableKeys(type, proposal)) {
    if (targetKey && key !== targetKey) continue;
    if (keep.has(key)) continue;
    result[key] = nextRecord[key];
  }
  return result;
}

export interface CompletenessIssue { key: string; message: string }

/** context.sitemap: the accepted «Карта сайта», so texts of a multi-page site are checked page by page. */
export function completenessIssues(type: ArtifactType, content: unknown, context: { sitemap?: Sitemap | null } = {}): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  if (type === 'brief') {
    const brief = content as Brief;
    if (!brief.businessName) issues.push({ key: 'businessName', message: 'Укажите название.' });
    if (!brief.whatYouDo) issues.push({ key: 'whatYouDo', message: 'Опишите, чем вы занимаетесь.' });
    if (!brief.audience) issues.push({ key: 'audience', message: 'Опишите ваших клиентов.' });
    if (!brief.tone) issues.push({ key: 'tone', message: 'Выберите, как говорить с клиентами.' });
    if (!brief.mainAction) issues.push({ key: 'mainAction', message: 'Выберите главное действие.' });
    if (brief.mainAction === 'call' && !brief.phone) issues.push({ key: 'phone', message: 'Для кнопки звонка нужен телефон.' });
    if (brief.mainAction === 'message' && !brief.messenger) issues.push({ key: 'messenger', message: 'Для кнопки мессенджера нужен @имя в Telegram или номер WhatsApp.' });
    if (brief.mainAction === 'email' && !brief.email) issues.push({ key: 'email', message: 'Для кнопки письма нужен email.' });
    if (brief.mainAction === 'visit' && !brief.address) issues.push({ key: 'address', message: 'Чтобы к вам пришли, нужен адрес.' });
  }
  if (type === 'schedule') issues.push(...scheduleIssues(content as Schedule));
  if (type === 'process') issues.push(...processIssues(content as BusinessProcess));
  if (type === 'sitemap') issues.push(...sitemapIssues(content as Sitemap));
  if (type === 'offer' && (content as Offer).services.length === 0) issues.push({ key: 'services', message: 'Добавьте хотя бы одну услугу.' });
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    if (context.sitemap) issues.push(...pageIssues(artifact, context.sitemap));
    else if (!artifact.sections.some((section) => section.type === 'hero')) issues.push({ key: 'sections', message: 'Добавьте первый экран.' });
    if (!artifact.sections.some((section) => section.type === 'contacts')) issues.push({ key: 'sections', message: 'Добавьте блок контактов.' });
    artifact.sections.forEach((section) => { if (!section.title) issues.push({ key: section.key, message: tr("У блока «{0}» нет заголовка.", [sectionTypeLabels[section.type]]) }); });
    if (!artifact.seo.title) issues.push({ key: 'seo', message: 'Добавьте заголовок для поисковиков.' });
    for (const section of artifact.sections) {
      if (PLACEHOLDER.test(JSON.stringify(section))) {
        issues.push({ key: section.key, message: tr("В блоке «{0}» остались места в квадратных скобках — замените их своими данными.", [section.title || sectionTypeLabels[section.type]]) });
      }
    }
  }
  return issues;
}

/** Texts of a multi-page site follow the map: every page has blocks, the home page starts with the first screen, no block is on an unknown page. */
export function pageIssues(content: ContentArtifact, sitemap: Sitemap): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  const known = new Set(sitemap.pages.map((page) => page.key));
  for (const page of sitemap.pages) {
    const blocks = content.sections.filter((section) => (section.page ?? 'home') === page.key);
    if (!blocks.length) issues.push({ key: page.key, message: tr('На странице «{0}» нет блоков.', [page.title]) });
    else if (page.path === '/' && blocks[0]!.type !== 'hero') issues.push({ key: page.key, message: tr('Главная страница должна начинаться с первого экрана.') });
    const seo = page.path === '/' ? content.seo : content.pageSeo?.find((item) => item.page === page.key);
    if (page.path !== '/' && !seo?.title) issues.push({ key: 'pageSeo', message: tr('Добавьте заголовок для поисковиков странице «{0}».', [page.title]) });
  }
  for (const section of content.sections) if (!known.has(section.page ?? 'home')) issues.push({ key: section.key, message: tr('Блок «{0}» стоит на странице, которой нет в карте сайта.', [section.title || sectionTypeLabels[section.type]]) });
  return issues;
}

export const defaultDesign: DesignArtifact = { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' };

export function emptyBrief(): Brief {
  return { businessName: '', whatYouDo: '', audience: '', city: null, mainAction: null, phone: null, messenger: null, email: null, address: null, tone: null };
}

const actionButton: Record<MainAction, () => string> = { call: () => tr('Позвонить'), message: () => tr('Написать нам'), visit: () => tr('Как нас найти'), email: () => tr('Написать письмо'), form: () => tr('Оставить заявку') };

function firstSentence(text: string, max: number): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Deterministic content draft used when no AI provider is configured. Missing facts become visible placeholders. */
export function templateContent(brief: Brief, offer: Offer | null, sitemap: Sitemap | null = null): ContentArtifact {
  if (sitemap) return templatePages(brief, offer, sitemap);
  const button = actionButton[brief.mainAction ?? 'message']();
  const place = brief.city ? tr(" в {0}", [brief.city]) : '';
  const sections: ContentSection[] = [
    { key: 'hero', type: 'hero', title: brief.businessName || tr("[укажите название]"), text: `${brief.whatYouDo || tr("[опишите, чем вы занимаетесь]")}${place && !brief.whatYouDo.includes(brief.city ?? '') ? `${place}.` : ''}`.trim(), items: [], buttonLabel: button, imageId: null },
    { key: 'about', type: 'about', title: tr("Для кого мы работаем"), text: brief.audience || tr("[опишите ваших клиентов]"), items: [], buttonLabel: null, imageId: null },
  ];
  if (offer?.services.length) {
    sections.push({ key: 'services', type: 'services', title: tr("Услуги и цены"), text: '', items: offer.services.map((service) => ({ title: service.price ? `${service.name} — ${service.price}` : service.name, text: service.description ?? '' })), buttonLabel: null, imageId: null });
  } else {
    sections.push({ key: 'benefits', type: 'benefits', title: tr("Почему выбирают нас"), text: '', items: [1, 2, 3].map((number) => ({ title: tr("[укажите преимущество {0}]", [number]), text: '' })), buttonLabel: null, imageId: null });
  }
  sections.push({
    key: 'steps', type: 'steps', title: tr("Как это работает"), text: '',
    items: [
      { title: brief.mainAction === 'visit' ? tr("Приходите к нам") : tr("Свяжитесь с нами"), text: brief.mainAction === 'visit' ? tr("Адрес и часы работы — в контактах ниже.") : tr("Ответим и уточним детали.") },
      { title: tr("Обсудим задачу"), text: tr("Подберём вариант под ваши пожелания.") },
      { title: tr("Получите результат"), text: tr("Сделаем в оговорённый срок.") },
    ],
    buttonLabel: null, imageId: null,
  });
  const form = brief.mainAction === 'form';
  sections.push({
    key: 'contacts', type: 'contacts', title: form ? tr("Оставьте заявку") : tr("Контакты"),
    text: brief.mainAction === 'visit' ? tr("Будем рады видеть вас.") : form ? tr("Заполните форму — мы свяжемся с вами.") : tr("Напишите или позвоните — ответим на вопросы."),
    items: [], buttonLabel: form ? null : button, imageId: null,
  });
  const title = brief.businessName ? `${brief.businessName}${brief.city ? ` — ${brief.city}` : ''}` : tr("[укажите название]");
  return {
    sections,
    seo: { title: title.slice(0, 70), description: firstSentence(brief.whatYouDo || tr("[опишите, чем вы занимаетесь]"), 160) },
  };
}

/** A multi-page draft: the blocks of every page in the order the map lists them, plus a search title and description per page. */
function templatePages(brief: Brief, offer: Offer | null, sitemap: Sitemap): ContentArtifact {
  const single = templateContent(brief, offer);
  const button = actionButton[brief.mainAction ?? 'message']();
  const pick = (type: SectionType): Omit<ContentSection, 'key'> => {
    const found = single.sections.find((section) => section.type === type);
    if (found) return found;
    if (type === 'services') return { type, title: tr('Услуги'), text: '', items: [1, 2, 3].map((number) => ({ title: tr('[укажите услугу {0}]', [number]), text: '' })), buttonLabel: null, imageId: null };
    if (type === 'benefits') return { type, title: tr('Почему выбирают нас'), text: '', items: [1, 2, 3].map((number) => ({ title: tr('[укажите преимущество {0}]', [number]), text: '' })), buttonLabel: null, imageId: null };
    if (type === 'faq') return { type, title: tr('Частые вопросы'), text: '', items: [1, 2, 3].map((number) => ({ title: tr('[укажите вопрос {0}]', [number]), text: tr('[добавьте ответ]') })), buttonLabel: null, imageId: null };
    return { type: 'cta', title: tr('Готовы начать?'), text: tr('Свяжитесь с нами — ответим и подскажем, с чего начать.'), items: [], buttonLabel: button, imageId: null };
  };
  const sections: ContentSection[] = sitemap.pages.flatMap((page) => page.sections.map((type) => ({ ...pick(type), key: `${page.key}-${type}`.slice(0, 40), page: page.key })));
  const name = brief.businessName || tr('[укажите название]');
  return {
    sections,
    seo: single.seo,
    pageSeo: sitemap.pages.filter((page) => page.path !== '/').map((page) => ({ page: page.key, title: `${page.title} — ${name}`.slice(0, 70), description: firstSentence(page.purpose || page.title, 160) })),
  };
}

/** Import pasted text: blocks separated by blank lines; first line of a block is its title. */
/**
 * Multi-page sites (sitemap given): blocks go to the current page; a block whose title is a page's menu name
 * («Услуги», «Контакты») starts that page. The first block is the home page's first screen.
 */
export function importContentText(text: string, sitemap: Sitemap | null = null): ContentArtifact {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).slice(0, sitemap ? 40 : 12);
  if (!blocks.length) throw new ArtifactValidationError('IMPORT_EMPTY');
  let page = 'home';
  const pageByTitle = new Map((sitemap?.pages ?? []).map((item) => [item.title.trim().toLowerCase(), item.key]));
  const sections: ContentSection[] = blocks.map((block, index) => {
    const [first, ...rest] = block.split('\n');
    const lower = first.toLowerCase();
    if (sitemap && index > 0 && pageByTitle.has(lower.trim())) page = pageByTitle.get(lower.trim())!;
    const type: SectionType = index === 0 ? 'hero' : /контакт|связ|адрес|contact|reach|address|find us/.test(lower) ? 'contacts' : /вопрос|question|faq/.test(lower) ? 'faq' : /услуг|цен|service|price/.test(lower) ? 'services' : /как.*работ|этап|how .*work|step/.test(lower) ? 'steps' : 'about';
    return { key: index === 0 ? 'hero' : `block-${index + 1}`, type, title: first.slice(0, 120), text: rest.join('\n').slice(0, 1200), items: [], buttonLabel: index === 0 ? tr("Связаться") : null, imageId: null, ...(sitemap ? { page } : {}) };
  });
  if (!sections.some((section) => section.type === 'contacts')) {
    const contactsPage = sitemap?.pages.find((item) => item.sections.includes('contacts'))?.key ?? 'home';
    sections.push({ key: 'contacts', type: 'contacts', title: tr("Контакты"), text: '', items: [], buttonLabel: tr("Связаться"), imageId: null, ...(sitemap ? { page: contactsPage } : {}) });
  }
  const pageSeo = sitemap?.pages.filter((item) => item.path !== '/').map((item) => ({ page: item.key, title: `${item.title} — ${sections[0]!.title}`.slice(0, 70), description: firstSentence(item.purpose || item.title, 160) }));
  return normalizeContent({ sections, seo: { title: sections[0].title.slice(0, 70), description: firstSentence(sections[0].text || sections[0].title, 160) }, ...(pageSeo ? { pageSeo } : {}) });
}

/** Import an offer list: one service per line, optional "— price" suffix. */
export function importOfferText(text: string): Offer {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 12);
  if (!lines.length) throw new ArtifactValidationError('IMPORT_EMPTY');
  return normalizeOffer({
    services: lines.map((line) => {
      const match = line.match(/^(.*?)\s+[—–-]\s+(.*\d.*)$/);
      return match ? { name: match[1].slice(0, 80), price: match[2].slice(0, 40) } : { name: line.slice(0, 80) };
    }),
    hours: null,
  });
}

/** Import brief text: keeps the full description; structured fields are filled by the owner or AI. */
export function importBriefText(text: string): Brief {
  const clean = text.trim();
  if (!clean) throw new ArtifactValidationError('IMPORT_EMPTY');
  const brief = emptyBrief();
  brief.whatYouDo = clean.slice(0, 400);
  const phone = clean.match(/\+?\d[\d\s()-]{8,16}\d/);
  if (phone) brief.phone = phone[0].slice(0, 30);
  const telegram = clean.match(/(?:^|\s)(@[a-zA-Z][a-zA-Z0-9_]{4,31})\b/);
  if (telegram) brief.messenger = telegram[1];
  const email = clean.match(/[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}/i);
  if (email) brief.email = email[0].slice(0, 120);
  return brief;
}
