import { ArtifactValidationError } from './artifacts.js';
import type { ProjectTypeKey } from './catalog.js';
import { measurable, type IdeaReview } from './idea.js';
import { PROCESS_LIMITS, type ActorKind, type BusinessProcess, type Capability } from './process.js';
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
/** rate: the developer's hourly rate in tenge the owner entered, for a price next to each estimate; null — hours only. */
export interface Suggestions { items: Suggestion[]; rate?: number | null }

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
  /** The step this adds to the business process when chosen: after the first step doing `after`. */
  step?: { after: Capability; actor: ActorKind; action: string; capability: Capability };
}

const SITES: ProjectTypeKey[] = ['landing', 'company_site', 'multipage', 'store', 'booking'];
const ALL: ProjectTypeKey[] = [...SITES, 'web_app'];

/** The catalog is code, versioned with SUGGESTIONS_VERSION: suggestions are the same for everyone with the same inputs. */
export const SUGGESTION_CATALOG: CatalogEntry[] = [
  { key: 'reminders', title: 'Напоминание клиенту о записи', value: 'Меньше клиентов забывают и не приходят.', effort: 'medium',
    types: ['booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['book'], lacks: ['remind_client'], step: { after: 'book', actor: 'system', action: 'Напоминает клиенту о записи накануне', capability: 'remind_client' } },
  { key: 'cancel_booking', title: 'Отмена и перенос записи самим клиентом', value: 'Освободившееся время снова видно другим, меньше звонков.', effort: 'medium',
    types: ['booking', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['book'], lacks: ['cancel_booking'], step: { after: 'book', actor: 'client', action: 'Сам отменяет или переносит запись', capability: 'cancel_booking' } },
  { key: 'pay_online', title: 'Онлайн-оплата', value: 'Деньги приходят сразу, меньше отказов в последний момент.', effort: 'large',
    types: ['store', 'booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['order'], lacks: ['pay_online'], step: { after: 'order', actor: 'client', action: 'Оплачивает заказ онлайн', capability: 'pay_online' } },
  { key: 'prepay_booking', title: 'Предоплата при записи', value: 'Клиенты реже пропускают запись.', effort: 'large',
    types: ['booking', 'web_app'], support: { site: 'account', app: 'account' }, has: ['book'], lacks: ['pay_online'], step: { after: 'book', actor: 'client', action: 'Вносит предоплату за запись', capability: 'pay_online' } },
  { key: 'owner_alerts', title: 'Уведомления о новых заявках в Telegram или на почту', value: 'Заявка не потеряется, ответ быстрее.', effort: 'small',
    types: ALL, support: { site: 'account', app: 'code' }, has: ['request_form'], lacks: ['notify_owner'], step: { after: 'request_form', actor: 'system', action: 'Сообщает владельцу о новой заявке', capability: 'notify_owner' } },
  { key: 'order_alerts', title: 'Уведомления о новых заказах и записях', value: 'Вы узнаёте о заказе сразу, а не когда зайдёте на сайт.', effort: 'small',
    types: ALL, support: { site: 'account', app: 'code' }, has: ['order'], lacks: ['notify_owner'], step: { after: 'order', actor: 'system', action: 'Сообщает владельцу о новом заказе', capability: 'notify_owner' } },
  { key: 'status_updates', title: 'Клиент видит статус своей заявки или заказа', value: 'Меньше вопросов «ну что там?».', effort: 'medium',
    types: ['store', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['change_status'], step: { after: 'change_status', actor: 'client', action: 'Видит новый статус своей заявки', capability: 'view_info' } },
  { key: 'client_account', title: 'Личный кабинет клиента', value: 'История заказов и повторный заказ в пару нажатий.', effort: 'large',
    types: ['store', 'booking', 'web_app'], support: { site: 'not_yet', app: 'code' }, has: ['create_request'], lacks: ['account'], step: { after: 'create_request', actor: 'client', action: 'Видит свои заявки и заказы в личном кабинете', capability: 'account' } },
  { key: 'staff_roles', title: 'Роли сотрудников и доступы', value: 'Каждый видит своё; уволенный сотрудник теряет доступ сразу.', effort: 'medium',
    types: ['web_app'], support: { site: 'not_yet', app: 'code' }, has: ['assign'], lacks: ['manage_staff'], step: { after: 'assign', actor: 'business', action: 'Даёт сотруднику доступ только к его заявкам', capability: 'manage_staff' } },
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
  const rate = raw.rate === null || raw.rate === undefined || raw.rate === '' ? null : Number(raw.rate);
  if (rate !== null && (!Number.isInteger(rate) || rate < 0 || rate > ESTIMATE_LIMITS.rate)) throw new ArtifactValidationError('FIELD_INVALID:rate');
  return { items: result, ...(rate !== null ? { rate } : {}) };
}

/**
 * A rough estimate by the kind of work, not a quote: developer hours with AI help for each effort, working days at
 * ESTIMATE_LIMITS.hoursPerDay, and a price when the owner entered a rate. What the platform makes on the site takes no
 * developer time; a service account (payments, messages) has its own fee on top, by its tariff.
 */
export const EFFORT_HOURS: Record<SuggestionEffort, [number, number]> = { small: [2, 6], medium: [6, 16], large: [16, 40] };
export const ESTIMATE_LIMITS = { rate: 1_000_000, hoursPerDay: 6 };
export interface SuggestionEstimate { hours: [number, number]; days: [number, number]; price: [number, number] | null; byPlatform: boolean; serviceFee: boolean }

const daysOf = (hours: number) => (hours ? Math.max(1, Math.ceil(hours / ESTIMATE_LIMITS.hoursPerDay)) : 0);

export function estimateSuggestion(item: Pick<Suggestion, 'effort' | 'support'>, rate: number | null | undefined): SuggestionEstimate {
  const byPlatform = item.support === 'site';
  const hours: [number, number] = byPlatform ? [0, 0] : EFFORT_HOURS[item.effort];
  return { hours, days: [daysOf(hours[0]), daysOf(hours[1])], price: rate ? [hours[0] * rate, hours[1] * rate] : null, byPlatform, serviceFee: item.support === 'account' };
}

/** What the first version adds: the sum over «В первую версию». Days assume one developer working in a row. */
export function estimateFirstVersion(value: Suggestions): { items: number; hours: [number, number]; days: [number, number]; price: [number, number] | null; serviceFees: number } {
  const now = value.items.filter((item) => item.decision === 'now');
  const estimates = now.map((item) => estimateSuggestion(item, value.rate));
  const hours: [number, number] = [estimates.reduce((sum, item) => sum + item.hours[0], 0), estimates.reduce((sum, item) => sum + item.hours[1], 0)];
  return { items: now.length, hours, days: [daysOf(hours[0]), daysOf(hours[1])], price: value.rate ? [hours[0] * value.rate, hours[1] * value.rate] : null, serviceFees: estimates.filter((item) => item.serviceFee).length };
}

const money = (value: number) => `${value.toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₸`;

/** «≈ 6–16 ч · 1–3 раб. дн. · 24 000 ₸–64 000 ₸», or that the platform does it. */
export function estimateText(estimate: Pick<SuggestionEstimate, 'hours' | 'days' | 'price'> & { byPlatform?: boolean; serviceFee?: boolean; serviceFees?: number }): string {
  if (estimate.byPlatform) return tr('делает платформа, без разработчика');
  const range = ([low, high]: [number, number], show: (value: number) => string | number = (value) => value) => (low === high ? `${show(low)}` : `${show(low)}–${show(high)}`);
  const parts = [tr('≈ {0} ч', [range(estimate.hours)]), tr('{0} раб. дн.', [range(estimate.days)])];
  if (estimate.price) parts.push(range(estimate.price, money));
  if (estimate.serviceFee) parts.push(tr('плюс плата сервиса по его тарифу'));
  if (estimate.serviceFees) parts.push(tr('плюс плата сервисов по их тарифам ({0})', [estimate.serviceFees]));
  return parts.join(' · ');
}

/** Support depends on the project kind; normalization cannot know it, so the template and the AI path fix it here. */
export function withHonestSupport(value: Suggestions, type: ProjectTypeKey): Suggestions {
  const kind: Kind = type === 'web_app' ? 'app' : 'site';
  return { ...value, items: value.items.map((item) => {
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
    for (const item of items) lines.push(`- **${item.title}** — ${item.value}${item.basis ? ` (${item.basis})` : ''}${item.reason ? `. ${tr('Причина')}: ${item.reason}` : ''}${decision === 'no' ? '' : `. ${tr('Оценка')}: ${estimateText(estimateSuggestion(item, value.rate))}`}`);
    lines.push('');
  }
  const total = estimateFirstVersion(value);
  if (total.items) lines.push(tr('Первая версия, оценка по типу работы (не смета): {0}.', [estimateText(total)]));
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

/** Who does an added step, in the owner's words, when the process has nobody of that kind yet. */
const ACTOR_NAMES: Record<ActorKind, string> = { client: 'Клиент', business: 'Владелец', staff: 'Сотрудник', system: 'Система', external: 'Внешний сервис' };

export interface StepAddition { suggestion: string; scenario: string; after: string; actor: string; action: string }
export interface StepSkip { suggestion: string; reason: string }

/**
 * New steps of the business process from the suggestions chosen for the first version (PRODUCT_LIFECYCLE.md §4.3): each
 * catalog suggestion that fills a missing step adds it right after the step it builds on, in every scenario that has that
 * step and not yet this one. Steps of the owner's or the AI's own suggestions are not guessed: they stay in the ТЗ only.
 */
export function processWithSuggestedSteps(process: BusinessProcess, suggestions: Suggestions): { process: BusinessProcess; added: StepAddition[]; skipped: StepSkip[] } {
  const next: BusinessProcess = structuredClone(process);
  const added: StepAddition[] = [];
  const skipped: StepSkip[] = [];
  const keys = new Set(next.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.key)));
  const actorOf = (kind: ActorKind) => {
    const found = next.actors.find((actor) => actor.kind === kind);
    if (found) return found;
    if (next.actors.length >= PROCESS_LIMITS.actors) return null;
    let key = kind; let n = 2;
    while (next.actors.some((actor) => actor.key === key)) key = `${kind}${n++}` as ActorKind;
    const actor = { key, name: tr(ACTOR_NAMES[kind]), kind };
    next.actors.push(actor);
    return actor;
  };
  for (const item of suggestions.items) {
    if (item.decision !== 'now') continue;
    const step = catalogEntry(item.catalogKey)?.step;
    if (!step) continue;
    const places = next.scenarios.filter((scenario) => scenario.steps.some((candidate) => candidate.capability === step.after));
    if (!places.length) { skipped.push({ suggestion: item.title, reason: tr('В процессе нет шага, к которому это добавить.') }); continue; }
    // Already there: a step doing the same (for a plain «посмотреть» step, the same words).
    const has = (candidate: { capability: Capability; action: string }) => candidate.capability === step.capability && (step.capability !== 'view_info' || candidate.action === tr(step.action));
    const todo = places.filter((scenario) => !scenario.steps.some(has));
    if (!todo.length) continue;
    const actor = actorOf(step.actor);
    if (!actor) { skipped.push({ suggestion: item.title, reason: tr('В процессе уже {0} участников — больше добавить нельзя.', [PROCESS_LIMITS.actors]) }); continue; }
    for (const scenario of todo) {
      if (scenario.steps.length >= PROCESS_LIMITS.steps) { skipped.push({ suggestion: item.title, reason: tr('В сценарии «{0}» уже {1} шагов.', [scenario.title, PROCESS_LIMITS.steps]) }); continue; }
      const at = scenario.steps.findIndex((candidate) => candidate.capability === step.after);
      let key = `${item.key}_step`.slice(0, 24); let n = 2;
      while (keys.has(key)) key = `${item.key.slice(0, 18)}_step${n++}`;
      keys.add(key);
      scenario.steps.splice(at + 1, 0, { key, actor: actor.key, action: tr(step.action), capability: step.capability });
      added.push({ suggestion: item.title, scenario: scenario.title, after: scenario.steps[at]!.action, actor: actor.name, action: tr(step.action) });
    }
  }
  return { process: next, added, skipped };
}

