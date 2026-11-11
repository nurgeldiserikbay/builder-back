// Typed artifact schemas, deterministic validation, locking/merge rules, templates and text import.
import { tr } from '../i18n/i18n.js';
import { corners, fonts, heroLayouts, palettes } from './site-renderer.js';
import type { ArtifactType } from './catalog.js';
import { normalizeSchedule, scheduleIssues, type BookingConfig, type Schedule } from './schedule.js';
import { normalizeTechPlan } from './techplan.js';
import { normalizeProcess, processIssues, type BusinessProcess } from './process.js';

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
export interface ContentSection { key: string; type: SectionType; title: string; text: string; items: ContentItem[]; buttonLabel: string | null; imageId: string | null }
export interface ContentArtifact { sections: ContentSection[]; seo: { title: string; description: string } }
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
  if (raw.sections.length < 1 || raw.sections.length > 12) throw new ArtifactValidationError('FIELD_COUNT:sections');
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
    };
  });
  return {
    sections,
    seo: { title: str(raw.seo.title, 'seo.title', 70, false) ?? '', description: str(raw.seo.description, 'seo.description', 160, false) ?? '' },
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
    default: throw new ArtifactValidationError('ARTIFACT_NOT_EDITABLE');
  }
}

/** Keys that can be locked against AI rewrites: brief/offer/design fields or content section keys. */
export function lockableKeys(type: ArtifactType, content: unknown): string[] {
  if (type === 'content') return (content as ContentArtifact).sections.map((section) => section.key).concat('seo');
  if (type === 'brief') return ['businessName', 'whatYouDo', 'audience', 'city', 'mainAction', 'phone', 'messenger', 'email', 'address', 'tone'];
  if (type === 'offer') return ['services', 'hours'];
  if (type === 'design') return ['palette', 'font', 'corners', 'heroLayout'];
  if (type === 'schedule') return ['timezone', 'services', 'masters', 'rules'];
  if (type === 'techplan') return ['ownerNotes'];
  if (type === 'process') return ['actors', 'scenarios', 'rules', 'data'];
  return [];
}

function valueAt(type: ArtifactType, content: unknown, key: string): unknown {
  if (!content) return undefined;
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    return key === 'seo' ? artifact.seo : artifact.sections.find((section) => section.key === key);
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
      if (targetKey === 'seo') return { ...baseContent, seo: next.seo };
      const replacement = next.sections.find((section) => section.key === targetKey) ?? next.sections[0];
      if (!replacement) return baseContent;
      return { ...baseContent, sections: baseContent.sections.map((section) => (section.key === targetKey ? { ...replacement, key: targetKey, imageId: replacement.imageId ?? section.imageId ?? null } : section)) };
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
    return { sections: sections.slice(0, 12), seo: keep.has('seo') ? baseContent.seo : next.seo };
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

export function completenessIssues(type: ArtifactType, content: unknown): CompletenessIssue[] {
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
  if (type === 'offer' && (content as Offer).services.length === 0) issues.push({ key: 'services', message: 'Добавьте хотя бы одну услугу.' });
  if (type === 'content') {
    const artifact = content as ContentArtifact;
    if (!artifact.sections.some((section) => section.type === 'hero')) issues.push({ key: 'sections', message: 'Добавьте первый экран.' });
    if (!artifact.sections.some((section) => section.type === 'contacts')) issues.push({ key: 'sections', message: 'Добавьте блок контактов.' });
    artifact.sections.forEach((section) => { if (!section.title) issues.push({ key: section.key, message: tr("У блока «{0}» нет заголовка.", [sectionTypeLabels[section.type]]) }); });
    if (!artifact.seo.title) issues.push({ key: 'seo', message: 'Добавьте заголовок для поисковиков.' });
    for (const section of artifact.sections) {
      if (/\[(?:укажите|заполните|добавьте)[^\]]*\]/i.test(JSON.stringify(section))) {
        issues.push({ key: section.key, message: tr("В блоке «{0}» остались места в квадратных скобках — замените их своими данными.", [section.title || sectionTypeLabels[section.type]]) });
      }
    }
  }
  return issues;
}

export const defaultDesign: DesignArtifact = { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' };

export function emptyBrief(): Brief {
  return { businessName: '', whatYouDo: '', audience: '', city: null, mainAction: null, phone: null, messenger: null, email: null, address: null, tone: null };
}

const actionButton: Record<MainAction, string> = { call: 'Позвонить', message: 'Написать нам', visit: 'Как нас найти', email: 'Написать письмо', form: 'Оставить заявку' };

function firstSentence(text: string, max: number): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Deterministic content draft used when no AI provider is configured. Missing facts become visible placeholders. */
export function templateContent(brief: Brief, offer: Offer | null): ContentArtifact {
  const button = actionButton[brief.mainAction ?? 'message'];
  const place = brief.city ? ` в ${brief.city}` : '';
  const sections: ContentSection[] = [
    { key: 'hero', type: 'hero', title: brief.businessName || '[укажите название]', text: `${brief.whatYouDo || '[опишите, чем вы занимаетесь]'}${place && !brief.whatYouDo.includes(brief.city ?? '') ? `${place}.` : ''}`.trim(), items: [], buttonLabel: button, imageId: null },
    { key: 'about', type: 'about', title: 'Для кого мы работаем', text: brief.audience || '[опишите ваших клиентов]', items: [], buttonLabel: null, imageId: null },
  ];
  if (offer?.services.length) {
    sections.push({ key: 'services', type: 'services', title: 'Услуги и цены', text: '', items: offer.services.map((service) => ({ title: service.price ? `${service.name} — ${service.price}` : service.name, text: service.description ?? '' })), buttonLabel: null, imageId: null });
  } else {
    sections.push({ key: 'benefits', type: 'benefits', title: 'Почему выбирают нас', text: '', items: [1, 2, 3].map((number) => ({ title: `[укажите преимущество ${number}]`, text: '' })), buttonLabel: null, imageId: null });
  }
  sections.push({
    key: 'steps', type: 'steps', title: 'Как это работает', text: '',
    items: [
      { title: brief.mainAction === 'visit' ? 'Приходите к нам' : 'Свяжитесь с нами', text: brief.mainAction === 'visit' ? 'Адрес и часы работы — в контактах ниже.' : 'Ответим и уточним детали.' },
      { title: 'Обсудим задачу', text: 'Подберём вариант под ваши пожелания.' },
      { title: 'Получите результат', text: 'Сделаем в оговорённый срок.' },
    ],
    buttonLabel: null, imageId: null,
  });
  const form = brief.mainAction === 'form';
  sections.push({
    key: 'contacts', type: 'contacts', title: form ? 'Оставьте заявку' : 'Контакты',
    text: brief.mainAction === 'visit' ? 'Будем рады видеть вас.' : form ? 'Заполните форму — мы свяжемся с вами.' : 'Напишите или позвоните — ответим на вопросы.',
    items: [], buttonLabel: form ? null : button, imageId: null,
  });
  const title = brief.businessName ? `${brief.businessName}${brief.city ? ` — ${brief.city}` : ''}` : '[укажите название]';
  return {
    sections,
    seo: { title: title.slice(0, 70), description: firstSentence(brief.whatYouDo || '[опишите, чем вы занимаетесь]', 160) },
  };
}

/** Import pasted text: blocks separated by blank lines; first line of a block is its title. */
export function importContentText(text: string): ContentArtifact {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).slice(0, 12);
  if (!blocks.length) throw new ArtifactValidationError('IMPORT_EMPTY');
  const sections: ContentSection[] = blocks.map((block, index) => {
    const [first, ...rest] = block.split('\n');
    const lower = first.toLowerCase();
    const type: SectionType = index === 0 ? 'hero' : /контакт|связ|адрес/.test(lower) ? 'contacts' : /вопрос/.test(lower) ? 'faq' : /услуг|цен/.test(lower) ? 'services' : /как.*работ|этап/.test(lower) ? 'steps' : 'about';
    return { key: index === 0 ? 'hero' : `block-${index + 1}`, type, title: first.slice(0, 120), text: rest.join('\n').slice(0, 1200), items: [], buttonLabel: index === 0 ? 'Связаться' : null, imageId: null };
  });
  if (!sections.some((section) => section.type === 'contacts')) {
    sections.push({ key: 'contacts', type: 'contacts', title: 'Контакты', text: '', items: [], buttonLabel: 'Связаться', imageId: null });
  }
  return normalizeContent({ sections, seo: { title: sections[0].title.slice(0, 70), description: firstSentence(sections[0].text || sections[0].title, 160) } });
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
