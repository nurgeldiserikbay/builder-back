// «План реализации» of a web application (builder-docs PRODUCT_LIFECYCLE.md §4.8): which parts the work is split into, in
// which order, what can go in parallel, what it costs and who does it. Drafted from the accepted contracts (modules and
// what they own), the ТЗ (features and priorities) and the architecture's schema (which module needs which). The graph,
// the critical path and the totals are computed, never stored: they always match the modules and their estimates.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import type { ArchitectureDesign } from './architecture.js';
import type { Contracts } from './contracts.js';
import type { IdeaReview } from './idea.js';
import type { AppFeatures, Priority } from './webapp.js';

export const ROADMAP_VERSION = '1.0.0';
export const ROADMAP_LIMITS = { modules: 16, tasks: 20, dependsOn: 15, risks: 12, text: 300, hours: 400, requests: 200 };
export const EXECUTORS = ['ai', 'ai_supervised', 'specialist'] as const;
export type Executor = (typeof EXECUTORS)[number];
export const RELEASES = [1, 2, 3] as const;

export interface RoadmapTask { key: string; title: string; feature: string | null; release: number; hours: number; aiRequests: number }
export interface RoadmapModule {
  key: string; name: string; summary: string;
  /** The contracts module it implements, so the plan follows the contract borders; null for the foundation. */
  contractModule: string | null;
  dependsOn: string[]; executor: Executor; tasks: RoadmapTask[];
}
export interface RoadmapRisk { key: string; text: string; action: string; module: string | null }
export interface Roadmap { modules: RoadmapModule[]; risks: RoadmapRisk[]; hoursPerDay: number; notes: string }

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
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
function keyer(prefix: string, used = new Set<string>()) {
  return (value: unknown, index: number) => {
    let key = typeof value === 'string' && KEY.test(value) ? value : `${prefix}${index + 1}`;
    let n = index + 1;
    while (used.has(key)) key = `${prefix}${++n}`;
    used.add(key);
    return key;
  };
}
const number = (value: unknown, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.round(parsed * 10) / 10, max) : 0;
};

export function normalizeRoadmap(raw: unknown): Roadmap {
  const value = isRecord(raw) ? raw : {};
  const moduleKey = keyer('m');
  const taskKey = keyer('t');
  const modules = list(value.modules, 'modules', ROADMAP_LIMITS.modules).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:modules.${index}`);
    const tasks = list(item.tasks, `modules.${index}.tasks`, ROADMAP_LIMITS.tasks).map((task, n) => {
      if (!isRecord(task)) throw new ArtifactValidationError(`FIELD_INVALID:modules.${index}.tasks.${n}`);
      const release = Number(task.release);
      return { key: task.key, title: text(task.title, `modules.${index}.tasks.${n}.title`, 160), feature: typeof task.feature === 'string' && KEY.test(task.feature) ? task.feature : null,
        release: (RELEASES as readonly number[]).includes(release) ? release : 1, hours: number(task.hours, ROADMAP_LIMITS.hours), aiRequests: Math.round(number(task.aiRequests, ROADMAP_LIMITS.requests)) };
    }).filter((task) => task.title);
    return {
      key: item.key, name: text(item.name, `modules.${index}.name`, 60), summary: text(item.summary, `modules.${index}.summary`, ROADMAP_LIMITS.text),
      contractModule: typeof item.contractModule === 'string' && KEY.test(item.contractModule) ? item.contractModule : null,
      dependsOn: Array.isArray(item.dependsOn) ? [...new Set(item.dependsOn.filter((key): key is string => typeof key === 'string' && KEY.test(key)))].slice(0, ROADMAP_LIMITS.dependsOn) : [],
      executor: (EXECUTORS as readonly unknown[]).includes(item.executor) ? item.executor as Executor : 'ai_supervised', tasks,
    };
  }).filter((item) => item.name).map((item, index) => ({ ...item, key: moduleKey(item.key, index) }));
  // Task keys are unique across the whole plan: progress is tracked by them.
  let position = 0;
  const withTasks: RoadmapModule[] = modules.map((module) => ({ ...module, tasks: module.tasks.map((task) => ({ ...task, key: taskKey(task.key, position++) })) }));
  // A dependency can only point at another module of this plan.
  const keys = new Set(withTasks.map((item) => item.key));
  for (const module of withTasks) module.dependsOn = module.dependsOn.filter((key) => key !== module.key && keys.has(key));
  const riskKey = keyer('r');
  const risks = list(value.risks, 'risks', ROADMAP_LIMITS.risks).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:risks.${index}`);
    return { key: item.key, text: text(item.text, `risks.${index}.text`, ROADMAP_LIMITS.text), action: text(item.action, `risks.${index}.action`, ROADMAP_LIMITS.text), module: typeof item.module === 'string' && keys.has(item.module) ? item.module : null };
  }).filter((item) => item.text).map((item, index) => ({ ...item, key: riskKey(item.key, index) }));
  const hoursPerDay = Math.min(Math.max(Math.round(Number(value.hoursPerDay) || 6), 1), 12);
  return { modules: withTasks, risks, hoursPerDay, notes: text(value.notes, 'notes', 1000) };
}

const releaseOf: Record<Priority, number> = { must: 1, should: 2, later: 3 };
const PAYMENT = /оплат|pay|kaspi|эквайр|stripe|cloudpayments/i;

/** The first plan without AI: a module per contracts module plus the foundation, tasks from operations, features, events and services. */
export function templateRoadmap(input: { contracts: Contracts; features: AppFeatures; design: ArchitectureDesign | null; idea: IdeaReview | null }): Roadmap {
  const { contracts, features, design, idea } = input;
  const featureOf = (key: string) => features.features.find((feature) => feature.key === key) ?? null;
  const modules: RoadmapModule[] = [{
    key: 'setup', name: tr('Каркас приложения'), summary: tr('Репозиторий, база по schema.sql, вход и роли, проверки, тестовое окружение.'), contractModule: null, dependsOn: [], executor: 'ai_supervised',
    tasks: [
      { key: 'setup_repo', title: tr('Репозиторий, сборка и автоматические проверки'), feature: null, release: 1, hours: 3, aiRequests: 3 },
      { key: 'setup_db', title: tr('База данных по миграции schema.sql'), feature: null, release: 1, hours: 2, aiRequests: 2 },
      { key: 'setup_env', title: tr('Тестовое окружение и выкладка'), feature: null, release: 1, hours: 3, aiRequests: 2 },
    ],
  }];
  for (const module of contracts.modules) {
    const operations = contracts.operations.filter((operation) => operation.module === module.key);
    const own = features.features.filter((feature) => module.features.includes(feature.key));
    const tasks: RoadmapTask[] = [];
    if (operations.length) tasks.push({ key: `${module.key}_api`.slice(0, 32), title: tr('Операции API: {0}', [operations.map((operation) => `${operation.method} ${operation.path}`).join(', ')]).slice(0, 160), feature: null,
      release: Math.min(...own.map((feature) => releaseOf[feature.priority]), 1), hours: Math.max(2, operations.length), aiRequests: Math.max(2, Math.ceil(operations.length / 2)) });
    for (const feature of own) tasks.push({ key: `f_${feature.key}`.slice(0, 32), title: tr('Функция «{0}»: экраны и проверки', [feature.title]).slice(0, 160), feature: feature.key, release: releaseOf[feature.priority], hours: 4 + feature.acceptance.length, aiRequests: 3 + feature.acceptance.length });
    // A module without operations still owns tables: someone creates them and their rules.
    if (!tasks.length) tasks.push({ key: `${module.key}_data`.slice(0, 32), title: tr('Таблицы и правила данных модуля «{0}»', [module.name]).slice(0, 160), feature: null, release: 1, hours: 1, aiRequests: 1 });
    modules.push({ key: module.key, name: module.name, summary: tr('Владеет данными: {0}', [module.owns.join(', ') || '—']).slice(0, 300), contractModule: module.key, dependsOn: ['setup'], executor: 'ai', tasks });
  }
  // Features no contracts module took (a feature without data) still need doing: they go to the first module of the user.
  const placed = new Set(modules.flatMap((module) => module.tasks.map((task) => task.feature)));
  const home = modules.find((module) => module.contractModule === 'accounts') ?? modules[0]!;
  for (const feature of features.features.filter((item) => !placed.has(item.key))) home.tasks.push({ key: `f_${feature.key}`.slice(0, 32), title: tr('Функция «{0}»: экраны и проверки', [feature.title]).slice(0, 160), feature: feature.key, release: releaseOf[feature.priority], hours: 4 + feature.acceptance.length, aiRequests: 3 + feature.acceptance.length });
  // Every module needs accounts (who is signed in and with which role); a record that points at another needs that one first.
  const moduleOfEntity = (entity: string) => modules.find((module) => module.contractModule && contracts.modules.find((item) => item.key === module.contractModule)?.owns.includes(entity))?.key ?? null;
  const accounts = modules.find((module) => module.contractModule === 'accounts')?.key ?? null;
  for (const module of modules) if (accounts && module.contractModule && module.key !== accounts) module.dependsOn.push(accounts);
  for (const relation of design?.schema.relations ?? []) {
    if (relation.kind === 'many_many') continue;
    const needs = moduleOfEntity(relation.to); const first = moduleOfEntity(relation.from);
    const module = modules.find((item) => item.key === needs);
    if (module && first && first !== needs && !module.dependsOn.includes(first) && !dependsOnPath(modules, first, module.key)) module.dependsOn.push(first);
  }
  if (contracts.events.length || contracts.integrations.length) {
    const tasks: RoadmapTask[] = [
      ...contracts.events.map((event, index) => ({ key: `ev_${index + 1}`, title: tr('Уведомление: {0}', [event.name]).slice(0, 160), feature: null, release: 1, hours: 2, aiRequests: 2 })),
      ...contracts.integrations.map((item, index) => ({ key: `in_${index + 1}`, title: tr('Интеграция «{0}» с поведением при сбое', [item.service]).slice(0, 160), feature: null, release: 1, hours: PAYMENT.test(item.service) ? 8 : 5, aiRequests: 4 })),
    ];
    modules.push({ key: 'notify', name: tr('Уведомления и интеграции'), summary: tr('События из контрактов и вызовы внешних сервисов.'), contractModule: null,
      dependsOn: modules.filter((module) => module.contractModule).map((module) => module.key), executor: contracts.integrations.some((item) => PAYMENT.test(item.service)) ? 'specialist' : 'ai_supervised', tasks });
  }
  const risks: RoadmapRisk[] = (idea?.risks ?? []).filter((risk) => risk.impact !== 'low' || risk.decision === 'open').map((risk) => ({ key: risk.key, text: risk.text, action: risk.note, module: null }));
  return normalizeRoadmap({ modules: modules.map((module) => ({ ...module, tasks: module.tasks.slice(0, ROADMAP_LIMITS.tasks) })), risks, hoursPerDay: 6, notes: '' });
}

/** True when `from` already reaches `to` through dependencies (to avoid adding a cycle). */
function dependsOnPath(modules: RoadmapModule[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const walk = (key: string): boolean => {
    if (key === to) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (modules.find((module) => module.key === key)?.dependsOn ?? []).some(walk);
  };
  return walk(from);
}

/** A cycle in the dependencies as module keys in order, or null. */
export function findCycle(value: Roadmap): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'open') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'open'); stack.push(key);
    for (const next of value.modules.find((module) => module.key === key)?.dependsOn ?? []) { const found = visit(next); if (found) return found; }
    stack.pop(); state.set(key, 'done');
    return null;
  };
  for (const module of value.modules) { const found = visit(module.key); if (found) return found; }
  return null;
}

export interface ScheduledModule { key: string; hours: number; aiRequests: number; start: number; finish: number; level: number; critical: boolean }
export interface RoadmapSchedule { modules: ScheduledModule[]; criticalPath: string[]; totalHours: number; totalRequests: number; days: number; byRelease: Array<{ release: number; hours: number; aiRequests: number; tasks: number }> }

/**
 * Earliest start and finish of each module in working hours, if every module starts as soon as what it needs is done
 * (parallel branches really run in parallel). The critical path is the chain that decides the finish date. A plan with
 * a cycle has no schedule.
 */
export function scheduleOf(value: Roadmap, release: number | null = null): RoadmapSchedule | null {
  if (findCycle(value)) return null;
  const hours = (module: RoadmapModule) => module.tasks.filter((task) => release === null || task.release <= release).reduce((sum, task) => sum + task.hours, 0);
  const requests = (module: RoadmapModule) => module.tasks.filter((task) => release === null || task.release <= release).reduce((sum, task) => sum + task.aiRequests, 0);
  const done = new Map<string, ScheduledModule>();
  const place = (module: RoadmapModule): ScheduledModule => {
    const known = done.get(module.key);
    if (known) return known;
    const before = module.dependsOn.map((key) => place(value.modules.find((item) => item.key === key)!));
    const start = Math.max(0, ...before.map((item) => item.finish));
    const result = { key: module.key, hours: hours(module), aiRequests: requests(module), start, finish: start + hours(module), level: before.length ? Math.max(...before.map((item) => item.level)) + 1 : 0, critical: false };
    done.set(module.key, result);
    return result;
  };
  const modules = value.modules.map(place);
  const end = Math.max(0, ...modules.map((item) => item.finish));
  // Walk back from the module that finishes last through the dependency that finishes exactly when it starts.
  const criticalPath: string[] = [];
  let current = modules.find((item) => item.finish === end && end > 0) ?? null;
  while (current) {
    current.critical = true;
    criticalPath.unshift(current.key);
    const source = value.modules.find((module) => module.key === current!.key)!;
    current = source.dependsOn.map((key) => done.get(key)!).filter((item) => item.finish === current!.start).sort((a, b) => b.hours - a.hours)[0] ?? null;
  }
  const all = value.modules.flatMap((module) => module.tasks);
  return {
    modules, criticalPath, totalHours: modules.reduce((sum, item) => sum + item.hours, 0), totalRequests: modules.reduce((sum, item) => sum + item.aiRequests, 0),
    days: Math.ceil(end / value.hoursPerDay),
    byRelease: RELEASES.map((number) => {
      const tasks = all.filter((task) => task.release === number);
      return { release: number, hours: tasks.reduce((sum, task) => sum + task.hours, 0), aiRequests: tasks.reduce((sum, task) => sum + task.aiRequests, 0), tasks: tasks.length };
    }).filter((item) => item.tasks > 0),
  };
}

export interface RoadmapIssue { code: string; severity: 'blocking' | 'important' | 'minor'; target: string; message: string; fix: string }

export function roadmapIssues(value: Roadmap, features: AppFeatures | null, contracts: Contracts | null): RoadmapIssue[] {
  const issues: RoadmapIssue[] = [];
  const name = (key: string) => value.modules.find((module) => module.key === key)?.name ?? key;
  const cycle = findCycle(value);
  if (cycle) issues.push({ code: 'ROADMAP_CYCLE', severity: 'blocking', target: cycle[0]!, message: tr('Модули ждут друг друга по кругу: {0}.', [cycle.map(name).join(' → ')]), fix: tr('Уберите одну из зависимостей: иначе ни один из них нельзя начать.') });
  const planned = new Set(value.modules.flatMap((module) => module.tasks.map((task) => task.feature)));
  for (const feature of (features?.features ?? []).filter((item) => item.priority === 'must' && !planned.has(item.key))) issues.push({ code: 'ROADMAP_FEATURE_MISSING', severity: 'important', target: 'modules', message: tr('Обязательная функция «{0}» не попала ни в один модуль.', [feature.title]), fix: tr('Добавьте задачу с этой функцией в модуль, который владеет её данными.') });
  for (const module of value.modules) {
    if (!module.tasks.length) issues.push({ code: 'ROADMAP_MODULE_EMPTY', severity: 'important', target: module.key, message: tr('В модуле «{0}» нет задач.', [module.name]), fix: tr('Добавьте задачи или уберите модуль.') });
    else if (module.tasks.some((task) => task.hours <= 0)) issues.push({ code: 'ROADMAP_NO_ESTIMATE', severity: 'important', target: module.key, message: tr('В модуле «{0}» есть задачи без оценки часов.', [module.name]), fix: tr('Оцените каждую задачу: по оценкам считаются срок и прогресс.') });
    // A must feature in a later release than what it relies on is fine; a first-release task in a module that waits for a later-release one is not.
    for (const dependency of module.dependsOn) {
      const other = value.modules.find((item) => item.key === dependency)!;
      const first = (item: RoadmapModule) => Math.min(...item.tasks.map((task) => task.release), 3);
      if (module.tasks.length && other.tasks.length && first(other) > first(module)) issues.push({ code: 'ROADMAP_RELEASE_ORDER', severity: 'minor', target: module.key, message: tr('Модуль «{0}» нужен в выпуске {1}, а ждёт «{2}», который начинается только в выпуске {3}.', [module.name, first(module), other.name, first(other)]), fix: tr('Перенесите нужные задачи «{0}» в более ранний выпуск или уберите зависимость.', [other.name]) });
    }
  }
  for (const module of contracts?.modules ?? []) if (!value.modules.some((item) => item.contractModule === module.key)) issues.push({ code: 'ROADMAP_CONTRACT_MODULE_MISSING', severity: 'important', target: 'modules', message: tr('Модуль контрактов «{0}» не реализуется ни одним модулем плана.', [module.name]), fix: tr('Добавьте модуль плана и укажите у него этот модуль контрактов.') });
  if (value.modules.length && !value.risks.length) issues.push({ code: 'ROADMAP_NO_RISKS', severity: 'minor', target: 'risks', message: tr('В плане нет рисков.'), fix: tr('Перенесите риски из разбора идеи или запишите свои: что может сорвать срок и что вы сделаете.') });
  for (const risk of value.risks.filter((item) => !item.action)) issues.push({ code: 'ROADMAP_RISK_NO_ACTION', severity: 'minor', target: risk.key, message: tr('У риска «{0}» нет действия.', [risk.text.slice(0, 60)]), fix: tr('Напишите, что сделаете, если он случится.') });
  return issues;
}

export const executorLabels = (): Record<Executor, string> => ({ ai: tr('ИИ-агент'), ai_supervised: tr('ИИ под присмотром специалиста'), specialist: tr('Специалист') });

export function roadmapMarkdown(value: Roadmap, features: AppFeatures | null): string {
  const schedule = scheduleOf(value);
  const executors = executorLabels();
  const name = (key: string) => value.modules.find((module) => module.key === key)?.name ?? key;
  const featureName = (key: string | null) => (key ? features?.features.find((feature) => feature.key === key)?.title ?? key : null);
  return [
    `# ${tr('План реализации')}`, '',
    ...(schedule ? [tr('Всего: {0} ч работы, около {1} запросов к ИИ; срок — около {2} раб. дней при {3} ч в день, с учётом параллельной работы.', [schedule.totalHours, schedule.totalRequests, schedule.days, value.hoursPerDay]), '',
      `${tr('Критический путь')}: ${schedule.criticalPath.map(name).join(' → ')}`, '',
      ...schedule.byRelease.map((item) => `- ${tr('Выпуск {0}: задач {1}, {2} ч, ~{3} запросов к ИИ', [item.release, item.tasks, item.hours, item.aiRequests])}`), '']
      : [tr('В зависимостях есть цикл — срок не считается.'), '']),
    '```mermaid', 'graph LR', ...value.modules.map((module) => `  ${module.key}["${module.name.replace(/"/g, "'")}"]`), ...value.modules.flatMap((module) => module.dependsOn.map((key) => `  ${key} --> ${module.key}`)),
    ...(schedule?.criticalPath.length ? [`  classDef critical stroke:#b3261e,stroke-width:3px`, `  class ${schedule.criticalPath.join(',')} critical`] : []), '```', '',
    ...value.modules.flatMap((module) => [
      `## ${module.name}`, '', module.summary, '', `${tr('Кто делает')}: ${executors[module.executor]}`, `${tr('Ждёт')}: ${module.dependsOn.map(name).join(', ') || '—'}`, '',
      ...module.tasks.map((task) => `- [ ] ${task.title} — ${tr('выпуск {0}, {1} ч, ~{2} запросов', [task.release, task.hours, task.aiRequests])}${featureName(task.feature) ? ` (${featureName(task.feature)})` : ''}`), '',
    ]),
    ...(value.risks.length ? [`## ${tr('Риски')}`, '', ...value.risks.map((risk) => `- ${risk.text}${risk.action ? ` — ${risk.action}` : ''}`), ''] : []),
    ...(value.notes ? [`## ${tr('Заметки')}`, '', value.notes, ''] : []),
  ].join('\n');
}

export function roadmapChanges(before: Roadmap, after: Roadmap): string[] {
  const lines: string[] = [];
  for (const module of after.modules) {
    const was = before.modules.find((item) => item.key === module.key);
    if (!was) lines.push(tr('Новый модуль «{0}»', [module.name]));
    else if (JSON.stringify(was) !== JSON.stringify(module)) lines.push(tr('Изменён модуль «{0}»', [module.name]));
  }
  for (const module of before.modules) if (!after.modules.some((item) => item.key === module.key)) lines.push(tr('Убран модуль «{0}»', [module.name]));
  if (JSON.stringify(before.risks) !== JSON.stringify(after.risks)) lines.push(tr('Изменены риски'));
  if (before.hoursPerDay !== after.hoursPerDay) lines.push(tr('Изменено число рабочих часов в день'));
  return lines;
}
