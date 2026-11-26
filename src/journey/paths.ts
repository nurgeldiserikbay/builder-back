// «Путь клиента» (stage key paths): how visitors of a site get from where they come from to the main action.
// For every kind of visitor: who they are, where they come from, what they want, the steps through the site,
// the action at the end, what may stop them and what on the site answers it. Texts and design are built along it.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError, type Brief, type Offer } from './artifacts.js';
import type { IdeaReview } from './idea.js';
import type { Sitemap } from './sitemap.js';

export const pathSources = ['search', 'maps', 'ads', 'social', 'messenger', 'referral', 'qr', 'other'] as const;
export type PathSource = (typeof pathSources)[number];
export const pathActions = ['call', 'message', 'form', 'email', 'visit', 'booking', 'order'] as const;
export type PathAction = (typeof pathActions)[number];

/** Labels the editor shows; Russian source strings, translated by the response interceptor. */
export const PATH_SOURCE_LABELS: Record<PathSource, string> = { search: 'Поиск в интернете', maps: 'Карты (2ГИС, Google, Яндекс)', ads: 'Реклама', social: 'Соцсети', messenger: 'Мессенджер', referral: 'Посоветовали знакомые', qr: 'QR-код или визитка', other: 'Другое' };
export const PATH_ACTION_LABELS: Record<PathAction, string> = { call: 'Звонит', message: 'Пишет в мессенджер', form: 'Оставляет заявку', email: 'Пишет на почту', visit: 'Приходит по адресу', booking: 'Записывается онлайн', order: 'Оформляет заказ' };

export interface PathStep { where: string; sees: string }
export interface CustomerPath { key: string; who: string; from: PathSource; wants: string; steps: PathStep[]; action: PathAction | null; doubt: string; answer: string }
export interface CustomerPaths { paths: CustomerPath[] }

export const PATHS_LIMITS = { paths: 5, steps: 6, longPath: 4 } as const;
const KEY = /^[a-z][a-z0-9-]{0,23}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, field: string, max: number): string => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return clean;
};
const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T | null): T | null => (typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : fallback);

export function normalizePaths(raw: unknown): CustomerPaths {
  if (!isRecord(raw) || !Array.isArray(raw.paths)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  if (raw.paths.length > PATHS_LIMITS.paths) throw new ArtifactValidationError('FIELD_COUNT:paths');
  const keys = new Set<string>();
  const paths = raw.paths.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:paths.${index}`);
    let key = typeof item.key === 'string' && KEY.test(item.key) && !keys.has(item.key) ? item.key : `path-${index + 1}`;
    while (keys.has(key)) key = `${key}-x`.slice(0, 24);
    keys.add(key);
    const steps = Array.isArray(item.steps) ? item.steps : [];
    if (steps.length > PATHS_LIMITS.steps) throw new ArtifactValidationError(`FIELD_COUNT:paths.${index}.steps`);
    return {
      key,
      who: text(item.who, `paths.${index}.who`, 120),
      from: oneOf(item.from, pathSources, 'other')!,
      wants: text(item.wants, `paths.${index}.wants`, 200),
      steps: steps.map((step, position) => {
        if (!isRecord(step)) throw new ArtifactValidationError(`FIELD_INVALID:paths.${index}.steps.${position}`);
        return { where: text(step.where, `paths.${index}.steps.${position}.where`, 60), sees: text(step.sees, `paths.${index}.steps.${position}.sees`, 200) };
      }).filter((step) => step.where || step.sees),
      action: oneOf(item.action, pathActions, null),
      doubt: text(item.doubt, `paths.${index}.doubt`, 200),
      answer: text(item.answer, `paths.${index}.answer`, 200),
    };
  });
  return { paths };
}

export interface PathsIssue { key: string; message: string }

/** What still has to be filled in before the paths can be accepted. */
export function pathsIssues(value: CustomerPaths): PathsIssue[] {
  const issues: PathsIssue[] = [];
  if (!value.paths.length) issues.push({ key: 'paths', message: tr('Добавьте хотя бы один путь: кто приходит на сайт и что он должен сделать.') });
  value.paths.forEach((path, index) => {
    const name = path.who || String(index + 1);
    if (!path.who) issues.push({ key: path.key, message: tr('У пути {0} не указано, кто этот посетитель.', [index + 1]) });
    if (!path.wants) issues.push({ key: path.key, message: tr('Напишите, зачем приходит посетитель «{0}».', [name]) });
    if (!path.steps.length) issues.push({ key: path.key, message: tr('Добавьте шаги пути «{0}»: что посетитель открывает и видит.', [name]) });
    if (!path.action) issues.push({ key: path.key, message: tr('Выберите, чем заканчивается путь «{0}»: звонок, сообщение, заявка…', [name]) });
  });
  return issues;
}

/** The action a site of this type can take: booking needs the schedule, an order — the catalog. */
export function actionAvailable(action: PathAction, projectType: string | null | undefined): boolean {
  if (action === 'booking') return projectType === 'booking';
  if (action === 'order') return projectType === 'store';
  return true;
}

/** The main action of the goal as the end of a path; a booking site books, a store takes orders. */
export function defaultAction(brief: Brief | null, projectType: string | null | undefined): PathAction | null {
  if (projectType === 'booking') return 'booking';
  if (projectType === 'store') return 'order';
  return brief?.mainAction ?? null;
}

/** Paths without AI: one per kind of visitor from the idea review (or the clients of the goal), along the site's pages. */
export function templatePaths(input: { brief: Brief | null; idea: IdeaReview | null; sitemap: Sitemap | null; offer: Offer | null; projectType: string | null }): CustomerPaths {
  const { brief, idea, sitemap, offer, projectType } = input;
  const who = (idea?.segments ?? []).map((segment) => ({ who: segment.name, wants: segment.need })).filter((item) => item.who).slice(0, 3);
  if (!who.length) who.push({ who: brief?.audience?.slice(0, 120) || tr('Новый клиент'), wants: brief?.whatYouDo ? tr('Узнать, подходит ли: {0}', [brief.whatYouDo]).slice(0, 200) : '' });
  const pages = sitemap?.pages ?? [];
  const page = (key: string) => pages.find((item) => item.key === key || item.sections.includes(key as never));
  const steps: PathStep[] = [{ where: pages[0]?.title || tr('Главная'), sees: tr('Кто вы, для кого и главная кнопка') }];
  if (projectType === 'store') steps.push({ where: tr('Каталог'), sees: tr('Товары, цены и наличие') }, { where: tr('Корзина'), sees: tr('Доставка, оплата и итог') });
  else if (projectType === 'booking') steps.push({ where: tr('Запись'), sees: tr('Услуга, мастер и свободное время') });
  else if (offer?.services.length || page('services')) steps.push({ where: page('services')?.title || tr('Услуги'), sees: tr('Что вы делаете и сколько стоит') });
  const action = defaultAction(brief, projectType);
  return normalizePaths({ paths: who.map((item, index) => ({ key: `path-${index + 1}`, who: item.who.slice(0, 120), from: 'search', wants: item.wants.slice(0, 200), steps, action, doubt: '', answer: '' })) });
}

/** The paths as Markdown lines for project.md: who, where from, the steps, the action, the doubt and its answer. */
export function pathsMarkdown(value: CustomerPaths): string[] {
  return value.paths.flatMap((path) => {
    const steps = [...path.steps.map((step) => step.where || step.sees), path.action ? tr(PATH_ACTION_LABELS[path.action]) : null].filter(Boolean);
    const lines = [tr('- **{0}** ({1}): {2}', [path.who, tr(PATH_SOURCE_LABELS[path.from]), path.wants]), `  ${steps.join(' → ')}`];
    if (path.doubt) lines.push(tr('  Сомнение: {0} — ответ: {1}', [path.doubt, path.answer || tr('не записан')]));
    return lines;
  });
}

/** Plain-language differences between two versions, for change notices. */
export function pathsChanges(before: CustomerPaths, after: CustomerPaths): string[] {
  const changes: string[] = [];
  const old = new Map(before.paths.map((path) => [path.key, path]));
  const now = new Set(after.paths.map((path) => path.key));
  for (const path of after.paths) {
    const was = old.get(path.key);
    if (!was) changes.push(tr('Добавлен путь «{0}»', [path.who]));
    else if (JSON.stringify(was) !== JSON.stringify(path)) changes.push(tr('Изменён путь «{0}»', [path.who]));
  }
  for (const path of before.paths) if (!now.has(path.key)) changes.push(tr('Убран путь «{0}»', [path.who]));
  return changes;
}
