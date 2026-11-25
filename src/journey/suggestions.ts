import { ArtifactValidationError } from './artifacts.js';
import type { ProjectTypeKey } from './catalog.js';
import { measurable, type IdeaReview } from './idea.js';
import type { BusinessProcess, Capability } from './process.js';
import { tr } from '../i18n/i18n.js';

/**
 * «Предложения функций» (PRODUCT_LIFECYCLE.md §4.3). A person does not know what products like theirs usually have; the
 * platform suggests it without imposing it. Each suggestion says what it gives, why it fits this project (a step of the
 * process or a goal of the idea review), how much work it adds and, honestly, whether the platform builds it.
 * The owner decides each one: into the first version, later or not needed. Decisions flow into the ТЗ.
 */

export const SUGGESTIONS_VERSION = '1.0.0';
export const SUGGESTION_LIMIT = 20;
/** More «now» than this and the first version stops being small: the review says so, the owner decides. */
export const FIRST_VERSION_EXTRAS = 6;

export type SuggestionDecision = 'now' | 'later' | 'no' | '';
/**
 * site — the platform puts it on the site itself; code — it goes into the generated application code and its checks;
 * account — needs a service of the owner's (payments, SMS, analytics), connected only with their consent;
 * not_yet — the platform does not build it yet: it goes into the ТЗ as a task for a developer.
 */
export type SuggestionSupport = 'site' | 'code' | 'account' | 'not_yet';
export type SuggestionEffort = 'small' | 'medium' | 'large';
export type SuggestionSource = 'catalog' | 'ai' | 'owner';

export interface Suggestion {
  key: string; title: string; value: string; basis: string; source: SuggestionSource; catalogKey: string | null;
  support: SuggestionSupport; effort: SuggestionEffort; decision: SuggestionDecision; reason: string;
}
export interface Suggestions { items: Suggestion[] }

const SUPPORTS: SuggestionSupport[] = ['site', 'code', 'account', 'not_yet'];
const EFFORTS: SuggestionEffort[] = ['small', 'medium', 'large'];
const DECISIONS: SuggestionDecision[] = ['now', 'later', 'no', ''];
const SOURCES: SuggestionSource[] = ['catalog', 'ai', 'owner'];

export const supportLabels = (): Record<SuggestionSupport, string> => ({
  site: tr('Платформа делает на сайте'), code: tr('Входит в код приложения'),
  account: tr('Нужен ваш аккаунт в сервисе — подключим только с вашего согласия'), not_yet: tr('Платформа пока не делает — пойдёт в ТЗ задачей для разработчика'),
});
export const effortLabels = (): Record<SuggestionEffort, string> => ({ small: tr('Немного работы'), medium: tr('Заметная работа'), large: tr('Большая работа') });
export const decisionLabels = (): Record<Exclude<SuggestionDecision, ''>, string> => ({ now: tr('В первую версию'), later: tr('Потом'), no: tr('Не нужно') });

type Kind = 'site' | 'app';
interface CatalogEntry {
  key: string; title: string; value: string; effort: SuggestionEffort;
  types: ProjectTypeKey[]; support: Record<Kind, SuggestionSupport>;
  /** Fits when the process has all of `has` and none of `lacks`; the first matching step is the basis. */
  has?: Capability[]; lacks?: Capability[];
  /** Fits a project with these goals in the idea review (the basis then is the goal). */
  goals?: boolean;
  /** Fits whatever the process: typical for the project type. */
  always?: boolean;
}

const SITES: ProjectTypeKey[] = ['landing', 'company_site', 'multipage', 'store', 'booking'];
const ALL: ProjectTypeKey[] = [...SITES, 'web_app'];

/** The catalog is code, versioned with SUGGESTIONS_VERSION: suggestions are the same for everyone with the same inputs. */
export const SUGGESTION_CATALOG: CatalogEntry[] = [
  { key: 'reminders', title: 'Напоминание клиенту о записи', value: 'Меньше клиентов забывают и не приходят.', effort: 'medium',
    types: ['booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['book'], lacks: ['remind_client'] },
  { key: 'cancel_booking', title: 'Отмена и перенос записи самим клиентом', value: 'Освободившееся время снова видно другим, меньше звонков.', effort: 'medium',
    types: ['booking', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['book'], lacks: ['cancel_booking'] },
  { key: 'pay_online', title: 'Онлайн-оплата', value: 'Деньги приходят сразу, меньше отказов в последний момент.', effort: 'large',
    types: ['store', 'booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['order'], lacks: ['pay_online'] },
  { key: 'prepay_booking', title: 'Предоплата при записи', value: 'Клиенты реже пропускают запись.', effort: 'large',
    types: ['booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['book'], lacks: ['pay_online'] },
  { key: 'owner_alerts', title: 'Уведомления о новых заявках в Telegram или на почту', value: 'Заявка не потеряется, ответ быстрее.', effort: 'small',
    types: ALL, support: { site: 'account', app: 'code' }, has: ['request_form'], lacks: ['notify_owner'] },
  { key: 'order_alerts', title: 'Уведомления о новых заказах и записях', value: 'Вы узнаёте о заказе сразу, а не когда зайдёте на сайт.', effort: 'small',
    types: ALL, support: { site: 'account', app: 'code' }, has: ['order'], lacks: ['notify_owner'] },
  { key: 'status_updates', title: 'Клиент видит статус своей заявки или заказа', value: 'Меньше вопросов «ну что там?».', effort: 'medium',
    types: ['store', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['change_status'] },
  { key: 'client_account', title: 'Личный кабинет клиента', value: 'История заказов и повторный заказ в пару нажатий.', effort: 'large',
    types: ['store', 'booking', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['create_request'], lacks: ['account'] },
  { key: 'staff_roles', title: 'Роли сотрудников и доступы', value: 'Каждый видит своё; уволенный сотрудник теряет доступ сразу.', effort: 'medium',
    types: ['web_app'], support: { site: 'not_yet', app: 'code' }, has: ['assign'], lacks: ['manage_staff'] },
  { key: 'reports', title: 'Отчёт для владельца: заявки, заказы, выручка за период', value: 'Видно, растёт ли бизнес, без таблиц вручную.', effort: 'medium',
    types: ['store', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['manage_orders'] },
  { key: 'export', title: 'Выгрузка данных в Excel', value: 'Бухгалтерия и отчёты без переписывания.', effort: 'small',
    types: ['web_app'], support: { site: 'not_yet', app: 'code' }, has: ['create_request'] },
  { key: 'search', title: 'Поиск и фильтры по каталогу', value: 'Клиент быстрее находит нужное и реже уходит.', effort: 'medium',
    types: ['store', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['choose_products'] },
  { key: 'messenger', title: 'Кнопка мессенджера на каждой странице', value: 'Написать проще, чем позвонить: больше обращений.', effort: 'small',
    types: SITES, support: { site: 'site', app: 'code' }, always: true },
  { key: 'faq', title: 'Ответы на частые вопросы', value: 'Меньше одинаковых вопросов, больше доверия.', effort: 'small',
    types: SITES, support: { site: 'site', app: 'code' }, always: true },
  { key: 'reviews', title: 'Отзывы клиентов', value: 'Новым клиентам проще решиться.', effort: 'small',
    types: SITES, support: { site: 'not_yet', app: 'code' }, always: true },
  { key: 'analytics', title: 'Аналитика посещений и заявок', value: 'Видно, достигаются ли цели и откуда приходят клиенты.', effort: 'small',
    types: ALL, support: { site: 'account', app: 'account' }, goals: true },
];

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string') { if (required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`); return ''; }
  const trimmed = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  if (!trimmed && required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`);
  return trimmed;
}
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options as readonly unknown[]).includes(value) ? value as T : fallback;
const catalogEntry = (key: string | null) => (key ? SUGGESTION_CATALOG.find((entry) => entry.key === key) : undefined);

export function normalizeSuggestions(raw: unknown): Suggestions {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const items = raw.items ?? [];
  if (!Array.isArray(items)) throw new ArtifactValidationError('FIELD_INVALID:items');
  if (items.length > SUGGESTION_LIMIT) throw new ArtifactValidationError('FIELD_TOO_MANY:items');
  const used = new Set<string>();
  const result: Suggestion[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:items.${index}`);
    const title = text(item.title, `items.${index}.title`, 80);
    if (!title) return;
    let key = typeof item.key === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(item.key) ? item.key : `s${index + 1}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    const entry = catalogEntry(typeof item.catalogKey === 'string' ? item.catalogKey : null);
    // What the platform builds is the platform's to say: a catalog item keeps the catalog's honesty, whatever came in.
    const source = entry ? 'catalog' : oneOf(item.source, SOURCES, 'owner') === 'catalog' ? 'owner' : oneOf(item.source, SOURCES, 'owner');
    const decision = oneOf(item.decision, DECISIONS, '');
    result.push({
      key, title, value: text(item.value, `items.${index}.value`, 300), basis: text(item.basis, `items.${index}.basis`, 300),
      source, catalogKey: entry?.key ?? null,
      support: entry ? oneOf(item.support, SUPPORTS, 'not_yet') : oneOf(item.support, SUPPORTS, 'not_yet'),
      effort: oneOf(item.effort, EFFORTS, entry?.effort ?? 'medium'), decision,
      reason: decision === 'now' ? '' : text(item.reason, `items.${index}.reason`, 300),
    });
  });
  return { items: result };
}

/** Support depends on the project kind; normalization cannot know it, so the template and the AI path fix it here. */
export function withHonestSupport(value: Suggestions, type: ProjectTypeKey): Suggestions {
  const kind: Kind = type === 'web_app' ? 'app' : 'site';
  return { items: value.items.map((item) => {
    const entry = catalogEntry(item.catalogKey);
    if (entry) return { ...item, support: entry.support[kind] };
    // The AI cannot promise the platform builds something outside the catalog: at most it goes into the app code.
    if (item.source === 'ai' && item.support === 'site') return { ...item, support: kind === 'app' ? 'code' : 'not_yet' };
    return item;
  }) };
}

export function suggestionsIssues(value: Suggestions): Array<{ key: string; message: string }> {
  const open = value.items.filter((item) => !item.decision);
  return open.length ? [{ key: 'decisions', message: tr('Решите по каждому предложению: в первую версию, потом или не нужно. Осталось: {0}.', [open.length]) }] : [];
}

/** Where a capability appears in the process, as the basis a person can check: «Сценарий „Запись“: клиент записывается». */
function stepBasis(process: BusinessProcess | null, capability: Capability): string | null {
  for (const scenario of process?.scenarios ?? []) {
    const step = scenario.steps.find((item) => item.capability === capability);
    if (step) return tr('Сценарий «{0}»: {1}', [scenario.title, step.action]);
  }
  return null;
}
const hasCapability = (process: BusinessProcess | null, capability: Capability) => (process?.scenarios ?? []).some((scenario) => scenario.steps.some((step) => step.capability === capability));

/** A draft without AI: catalog entries that fit the project type and the process, each with its basis. No decisions. */
export function templateSuggestions(type: ProjectTypeKey, idea: IdeaReview | null, process: BusinessProcess | null): Suggestions {
  const items: Suggestion[] = [];
  for (const entry of SUGGESTION_CATALOG) {
    if (!entry.types.includes(type)) continue;
    let basis: string | null = null;
    if (entry.has) {
      if (!entry.has.every((capability) => hasCapability(process, capability))) continue;
      if (entry.lacks?.some((capability) => hasCapability(process, capability))) continue;
      basis = stepBasis(process, entry.has[0]!);
    } else if (entry.goals) {
      const goal = idea?.metrics.find((metric) => measurable(metric.text));
      basis = goal ? tr('Цель: {0}', [goal.text]) : tr('Чтобы понять, работает ли продукт');
    } else if (entry.always) {
      basis = tr('Обычно есть у таких проектов');
    }
    if (!basis) continue;
    items.push({ key: entry.key, title: tr(entry.title), value: tr(entry.value), basis, source: 'catalog', catalogKey: entry.key, support: 'not_yet', effort: entry.effort, decision: '', reason: '' });
  }
  return withHonestSupport({ items: items.slice(0, SUGGESTION_LIMIT) }, type);
}

/** The catalog as the AI sees it: it chooses from here first and adds its own only with a basis. */
export function catalogForAi(type: ProjectTypeKey): string {
  return SUGGESTION_CATALOG.filter((entry) => entry.types.includes(type))
    .map((entry) => `- ${entry.key}: ${entry.title} — ${entry.value}`).join('\n');
}

/** Chosen suggestions as ТЗ features: «now» is a must of the first version, «later» stays in the list as later. */
export function chosenForSpec(value: Suggestions | null): Array<{ key: string; title: string; description: string; priority: 'must' | 'later'; acceptance: string[] }> {
  return (value?.items ?? []).filter((item) => item.decision === 'now' || item.decision === 'later').map((item) => ({
    key: `x_${item.key}`.slice(0, 24), title: item.title,
    description: [item.value, item.support === 'not_yet' ? tr('Платформа пока не делает — задача для разработчика.') : item.support === 'account' ? tr('Нужен аккаунт владельца в сервисе.') : ''].filter(Boolean).join(' '),
    priority: item.decision === 'now' ? 'must' : 'later',
    // A starting «готово» the owner sharpens in the ТЗ: what the suggestion promised, checked by hand.
    acceptance: item.value ? [tr('Готово, когда: {0}', [item.value.replace(/[.\s]+$/, '').toLowerCase()])] : [],
  }));
}

export function suggestionsChanges(before: Suggestions, after: Suggestions): string[] {
  const lines: string[] = [];
  const old = new Map(before.items.map((item) => [item.key, item]));
  const labels = decisionLabels();
  for (const item of after.items) {
    const previous = old.get(item.key);
    if (!previous) lines.push(tr('Добавлено предложение «{0}».', [item.title]));
    else if (previous.decision !== item.decision && item.decision) lines.push(tr('«{0}»: {1}.', [item.title, labels[item.decision]]));
    old.delete(item.key);
  }
  for (const item of old.values()) lines.push(tr('Убрано предложение «{0}».', [item.title]));
  return lines;
}

export function suggestionsMarkdown(value: Suggestions): string {
  const labels = decisionLabels();
  const group = (decision: Exclude<SuggestionDecision, ''>) => value.items.filter((item) => item.decision === decision);
  const lines: string[] = [];
  for (const decision of ['now', 'later', 'no'] as const) {
    const items = group(decision);
    if (!items.length) continue;
    lines.push(`### ${labels[decision]}`, '');
    for (const item of items) lines.push(`- **${item.title}** — ${item.value}${item.basis ? ` (${item.basis})` : ''}${item.reason ? `. ${tr('Причина')}: ${item.reason}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** A pasted wish list: each line (a bullet, a number or plain text) becomes the owner's suggestion with no decision yet. */
export function importSuggestionsText(text: string): Suggestions {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, '').trim()).filter((line) => line.length >= 3);
  const items = lines.slice(0, SUGGESTION_LIMIT).map((line, index) => {
    const [title, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
    return { key: `s${index + 1}`, title: title!.slice(0, 80), value: rest.join(' — ').slice(0, 300), basis: '', source: 'owner', catalogKey: null, support: 'not_yet', effort: 'medium', decision: '', reason: '' };
  });
  return normalizeSuggestions({ items });
}
