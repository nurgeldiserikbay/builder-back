// The ТЗ made checkable (builder-docs PRODUCT_LIFECYCLE.md §4.5): user stories with «Дано / Когда / Тогда» cases that later
// become test cases, who may do what with which data, non-functional requirements in plain words, the outside services with
// who gives access, and tracing — every feature says where it comes from and every step the product takes is covered.
// All of it is optional in stored content: a ТЗ written before has empty lists here and keeps working.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import type { BusinessProcess, ProcessActor } from './process.js';
import type { Suggestions } from './suggestions.js';

export const SPEC_EXTRAS_LIMITS = { story: 240, cases: 5, caseText: 240, sources: 8, access: 60, services: 8, quality: 200 };
export const ACCESS_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];
export const SERVICE_ACCESS = ['owner', 'platform', 'developer'] as const;
export type ServiceAccess = (typeof SERVICE_ACCESS)[number];
export const QUALITY_KEYS = ['speed', 'users', 'languages', 'devices', 'accessibility', 'dataLocation', 'backups', 'retention'] as const;
export type QualityKey = (typeof QUALITY_KEYS)[number];

/** A check of a feature: given a state, when someone acts, then this is the result. Becomes a test case. */
export interface FeatureCase { key: string; given: string; when: string; then: string }
/** One row of the access matrix: a role, a kind of data, what it may do with it, and whether only its own records or all. */
export interface AccessRule { key: string; role: string; data: string; actions: AccessAction[]; scope: 'own' | 'all' }
export interface SpecService { key: string; name: string; purpose: string; accessBy: ServiceAccess }
export type SpecQuality = Record<QualityKey, string>;

export const actionLabels = (): Record<AccessAction, string> => ({ view: tr('смотреть'), create: tr('создавать'), edit: tr('менять'), delete: tr('удалять') });
export const accessByLabels = (): Record<ServiceAccess, string> => ({ owner: tr('Владелец даёт свой аккаунт'), platform: tr('Подключает платформа'), developer: tr('Подключает разработчик') });
export const qualityLabels = (): Record<QualityKey, string> => ({
  speed: tr('Скорость'), users: tr('Сколько пользователей'), languages: tr('Языки'), devices: tr('Устройства'),
  accessibility: tr('Доступность'), dataLocation: tr('Где хранятся данные'), backups: tr('Резервные копии'), retention: tr('Сколько хранить данные'),
});
export const emptyQuality = (): SpecQuality => Object.fromEntries(QUALITY_KEYS.map((key) => [key, ''])) as SpecQuality;

/**
 * Where a feature comes from: «step:<scenario>.<step>» — a step of the business process; «suggestion:<key>» — a choice in
 * «Предложения функций»; «rule:<name>» — a platform rule (accounts, personal data); «owner» — the owner asked for it.
 */
export const SOURCE_PATTERN = /^(step:[a-z][a-z0-9_]{0,23}\.[a-z][a-z0-9_]{0,23}|suggestion:[a-z][a-z0-9_]{0,23}|rule:[a-z][a-z0-9_]{0,23}|owner)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return trimmed;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  if (value.length > max) throw new ArtifactValidationError(`FIELD_TOO_MANY:${field}`);
  return value;
}
function keyFor(value: unknown, prefix: string, index: number, used: Set<string>): string {
  let key = typeof value === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(value) ? value : `${prefix}${index + 1}`;
  while (used.has(key)) key = `${key}_`;
  used.add(key);
  return key;
}

export function normalizeCases(raw: unknown, field: string): FeatureCase[] {
  const used = new Set<string>();
  return list(raw, field, SPEC_EXTRAS_LIMITS.cases).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:${field}.${index}`);
    return { key: item.key, given: text(item.given, `${field}.${index}.given`, SPEC_EXTRAS_LIMITS.caseText), when: text(item.when, `${field}.${index}.when`, SPEC_EXTRAS_LIMITS.caseText), then: text(item.then, `${field}.${index}.then`, SPEC_EXTRAS_LIMITS.caseText) };
  }).filter((item) => item.when || item.then).map((item, index) => ({ ...item, key: keyFor(item.key, 'c', index, used) }));
}

export function normalizeSources(raw: unknown, field: string): string[] {
  return [...new Set(list(raw, field, SPEC_EXTRAS_LIMITS.sources).filter((item): item is string => typeof item === 'string' && SOURCE_PATTERN.test(item)))];
}

/** Rows naming a role or data that do not exist are dropped: the lists may have been edited after. «user» is the accounts. */
export function normalizeAccess(raw: unknown, roles: Set<string>, data: Set<string>): AccessRule[] {
  const used = new Set<string>();
  const seen = new Set<string>();
  const rows: AccessRule[] = [];
  list(raw, 'access', SPEC_EXTRAS_LIMITS.access).forEach((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:access.${index}`);
    const role = typeof item.role === 'string' ? item.role : '';
    const entity = typeof item.data === 'string' ? item.data : '';
    if (!roles.has(role) || !(data.has(entity) || entity === 'user') || seen.has(`${role}:${entity}`)) return;
    seen.add(`${role}:${entity}`);
    const actions = ACCESS_ACTIONS.filter((action) => Array.isArray(item.actions) && item.actions.includes(action));
    rows.push({ key: keyFor(item.key, 'a', index, used), role, data: entity, actions, scope: item.scope === 'own' ? 'own' : 'all' });
  });
  return rows;
}

export function normalizeServices(raw: unknown, legacy: string[]): SpecService[] {
  const used = new Set<string>();
  const items = list(raw, 'services', SPEC_EXTRAS_LIMITS.services);
  // A ТЗ from before services: its integrations become services the owner still has to describe.
  const source = items.length ? items : legacy.map((name) => ({ name }));
  return source.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:services.${index}`);
    return { key: item.key, name: text(item.name, `services.${index}.name`, 80), purpose: text(item.purpose, `services.${index}.purpose`, 200), accessBy: (SERVICE_ACCESS as readonly unknown[]).includes(item.accessBy) ? item.accessBy as ServiceAccess : 'owner' };
  }).filter((item) => item.name).map((item, index) => ({ ...item, key: keyFor(item.key, 'svc', index, used) }));
}

export function normalizeQuality(raw: unknown): SpecQuality {
  const value = isRecord(raw) ? raw : {};
  return Object.fromEntries(QUALITY_KEYS.map((key) => [key, text(value[key], `quality.${key}`, SPEC_EXTRAS_LIMITS.quality)])) as SpecQuality;
}

/** The steps the product takes on itself — not done by hand outside it — that a feature must cover. */
export function productSteps(process: BusinessProcess | null): Array<{ ref: string; scenario: string; action: string }> {
  return (process?.scenarios ?? []).flatMap((scenario) => scenario.steps
    .filter((step) => step.capability !== 'offline' && step.capability !== 'other')
    .map((step) => ({ ref: `step:${scenario.key}.${step.key}`, scenario: scenario.title, action: step.action })));
}

/** Each product step and the features that cover it; empty «by» means nothing in the ТЗ does that step. */
export function coverage(process: BusinessProcess | null, features: Array<{ key: string; title: string; sources?: string[] }>) {
  return productSteps(process).map((step) => ({ ...step, by: features.filter((feature) => (feature.sources ?? []).includes(step.ref)).map((feature) => feature.title) }));
}

/** Who may do what by default, from what kind of participant the role is in the process. The owner refines it. */
export function templateAccess(roles: Array<{ key: string }>, actors: ProcessActor[], features: Array<{ roles: string[]; data: string[] }>, app: boolean): AccessRule[] {
  const rows: AccessRule[] = [];
  for (const role of roles) {
    const kind = actors.find((actor) => actor.key === role.key)?.kind ?? (role.key === 'admin' ? 'business' : 'client');
    const data = [...new Set(features.filter((feature) => feature.roles.includes(role.key)).flatMap((feature) => feature.data))];
    for (const entity of data) {
      const actions: AccessAction[] = kind === 'business' ? [...ACCESS_ACTIONS] : kind === 'staff' ? ['view', 'edit'] : entity === 'user' ? ['view', 'edit', 'delete'] : ['view', 'create'];
      // A client sees only their own records; on a website visitors do not sign in, so they only create.
      const scope = kind === 'client' ? 'own' : 'all';
      rows.push({ key: `a${rows.length + 1}`, role: role.key, data: entity, actions: !app && kind === 'client' ? ['create'] : actions, scope });
    }
  }
  return rows.slice(0, SPEC_EXTRAS_LIMITS.access);
}

/** Services the owner chose that need an account, and online payment when the process takes it. */
export function templateServices(suggestions: Suggestions | null, process: BusinessProcess | null): SpecService[] {
  const services: SpecService[] = [];
  for (const item of suggestions?.items ?? []) {
    if (item.support === 'account' && (item.decision === 'now' || item.decision === 'later')) services.push({ key: `svc${services.length + 1}`, name: item.title, purpose: item.value, accessBy: 'owner' });
  }
  const pays = (process?.scenarios ?? []).some((scenario) => scenario.steps.some((step) => step.capability === 'pay_online'));
  if (pays && !services.some((service) => /оплат|payment/i.test(service.name))) services.push({ key: `svc${services.length + 1}`, name: tr('Онлайн-оплата'), purpose: tr('Приём оплаты картой'), accessBy: 'owner' });
  return services.slice(0, SPEC_EXTRAS_LIMITS.services);
}

/** What can be said without guessing: devices and language. The rest is the owner's to decide and stays empty. */
export function templateQuality(languageName: string): SpecQuality {
  return { ...emptyQuality(), devices: tr('Телефон и компьютер; всё работает на экране от 360 пикселей.'), languages: languageName };
}

/** A starting story and case from a scenario; the owner or the AI makes them concrete. */
export function scenarioStory(actor: string, goal: string): string {
  const lower = goal.charAt(0).toLowerCase() + goal.slice(1);
  return goal ? tr('Как {0}, я хочу {1}', [actor.toLowerCase(), lower.replace(/[.\s]+$/, '')]).slice(0, SPEC_EXTRAS_LIMITS.story) : '';
}
