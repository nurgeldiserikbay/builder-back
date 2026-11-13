// «Веб-приложение»: a product with roles, accounts and its own logic. BuildPath does not write or run the application code
// (TECHNICAL_SPECIFICATION.md §6 capability manifest): it takes the project to a complete, checked package for a developer —
// roles and functions with acceptance criteria, screens with a clickable prototype, architecture with a data model and an
// API contract — all derived deterministically from accepted stages, so the package always matches what was agreed.
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { ArtifactValidationError, type Brief } from './artifacts.js';
import type { BusinessProcess, ProcessEntity } from './process.js';
import { escapeHtml } from './site-renderer.js';
import { pathFor } from './sitemap.js';
import { TECHPLAN_VERSION, type DataEntity, type Sequence, type TechPlan, type TechPlanItem } from './techplan.js';

export const WEBAPP_VERSION = '1.0.0';
export const APP_LIMITS = { roles: 6, features: 30, acceptance: 6, integrations: 8, screens: 20, blocks: 8, fields: 12, links: 8 };
export const PRIORITIES = ['must', 'should', 'later'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const SENSITIVITY = ['normal', 'personal', 'payments', 'health'] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];
export const BLOCK_KINDS = ['list', 'table', 'form', 'details', 'text', 'actions', 'stats', 'search'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const priorityLabels: Record<Priority, string> = { must: 'Обязательно в первой версии', should: 'Желательно', later: 'Позже' };
export const sensitivityLabels: Record<Sensitivity, string> = {
  normal: 'Обычные данные', personal: 'Персональные данные клиентов', payments: 'Платежи и деньги', health: 'Здоровье или другие особо чувствительные данные',
};
export const blockLabels: Record<BlockKind, string> = {
  list: 'Список', table: 'Таблица', form: 'Форма', details: 'Карточка с данными', text: 'Текст', actions: 'Кнопки действий', stats: 'Показатели', search: 'Поиск и фильтры',
};

export interface AppRole { key: string; name: string; description: string }
export interface AppFeature { key: string; title: string; description: string; roles: string[]; priority: Priority; acceptance: string[] }
export interface AppFeatures { roles: AppRole[]; features: AppFeature[]; sensitivity: Sensitivity; integrations: string[] }
export interface ScreenBlock { kind: BlockKind; title: string; fields: string[] }
export interface AppScreen { key: string; title: string; role: string; purpose: string; features: string[]; blocks: ScreenBlock[]; links: string[] }
export interface AppScreens { screens: AppScreen[] }
export interface AppIssue { key: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string') { if (required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`); return ''; }
  const trimmed = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  if (!trimmed && required) throw new ArtifactValidationError(`FIELD_REQUIRED:${field}`);
  return trimmed;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  if (value.length > max) throw new ArtifactValidationError(`FIELD_TOO_MANY:${field}`);
  return value;
}
function keyOf(value: unknown, prefix: string, index: number, used: Set<string>): string {
  let key = typeof value === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(value) ? value : `${prefix}${index + 1}`;
  while (used.has(key)) key = `${key}_`;
  used.add(key);
  return key;
}
const strings = (value: unknown, field: string, max: number, length: number) => list(value, field, max).map((item, index) => text(item, `${field}.${index}`, length, false)).filter(Boolean);

export function normalizeFeatures(raw: unknown): AppFeatures {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const roleKeys = new Set<string>();
  const roles = list(raw.roles, 'roles', APP_LIMITS.roles).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:roles.${index}`);
    return { key: keyOf(item.key, 'role', index, roleKeys), name: text(item.name, `roles.${index}.name`, 40), description: text(item.description, `roles.${index}.description`, 200, false) };
  });
  const featureKeys = new Set<string>();
  const features = list(raw.features, 'features', APP_LIMITS.features).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:features.${index}`);
    const priority = PRIORITIES.includes(item.priority as Priority) ? item.priority as Priority : 'should';
    return {
      key: keyOf(item.key, 'f', index, featureKeys), title: text(item.title, `features.${index}.title`, 80), description: text(item.description, `features.${index}.description`, 400, false),
      // Roles that do not exist are dropped rather than refused: the role list may have been edited after.
      roles: [...new Set(strings(item.roles, `features.${index}.roles`, APP_LIMITS.roles, 24))].filter((key) => roleKeys.has(key)),
      priority, acceptance: strings(item.acceptance, `features.${index}.acceptance`, APP_LIMITS.acceptance, 200),
    };
  });
  const sensitivity = SENSITIVITY.includes(raw.sensitivity as Sensitivity) ? raw.sensitivity as Sensitivity : 'personal';
  return { roles, features, sensitivity, integrations: strings(raw.integrations, 'integrations', APP_LIMITS.integrations, 80) };
}

export function featuresIssues(value: AppFeatures): AppIssue[] {
  const issues: AppIssue[] = [];
  if (!value.roles.length) issues.push({ key: 'roles', message: 'Добавьте хотя бы одну роль: кто будет пользоваться приложением.' });
  if (!value.features.some((feature) => feature.priority === 'must')) issues.push({ key: 'features', message: 'Отметьте хотя бы одну функцию как обязательную в первой версии.' });
  for (const feature of value.features) {
    if (!feature.roles.length) issues.push({ key: feature.key, message: `У функции «${feature.title}» не указано, кто ей пользуется.` });
    if (!feature.acceptance.length) issues.push({ key: feature.key, message: `У функции «${feature.title}» нет критерия приёмки: как понять, что она работает.` });
  }
  return issues;
}

export function normalizeScreens(raw: unknown): AppScreens {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const keys = new Set<string>();
  const screens = list(raw.screens, 'screens', APP_LIMITS.screens).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:screens.${index}`);
    const blocks = list(item.blocks, `screens.${index}.blocks`, APP_LIMITS.blocks).map((block, blockIndex) => {
      if (!isRecord(block)) throw new ArtifactValidationError(`FIELD_INVALID:screens.${index}.blocks.${blockIndex}`);
      const kind = BLOCK_KINDS.includes(block.kind as BlockKind) ? block.kind as BlockKind : 'text';
      return { kind, title: text(block.title, `screens.${index}.blocks.${blockIndex}.title`, 80, false), fields: strings(block.fields, `screens.${index}.blocks.${blockIndex}.fields`, APP_LIMITS.fields, 60) };
    });
    return {
      key: keyOf(item.key, 's', index, keys), title: text(item.title, `screens.${index}.title`, 60), role: typeof item.role === 'string' ? item.role.slice(0, 24) : '',
      purpose: text(item.purpose, `screens.${index}.purpose`, 300, false), features: [...new Set(strings(item.features, `screens.${index}.features`, APP_LIMITS.features, 24))],
      blocks, links: [...new Set(strings(item.links, `screens.${index}.links`, APP_LIMITS.links, 24))],
    };
  });
  // Links to screens that are not there are dropped.
  return { screens: screens.map((screen) => ({ ...screen, links: screen.links.filter((key) => key !== screen.key && keys.has(key)) })) };
}

export function screensIssues(value: AppScreens, features: AppFeatures | null): AppIssue[] {
  const issues: AppIssue[] = [];
  if (!value.screens.length) return [{ key: 'screens', message: 'Добавьте хотя бы один экран.' }];
  if (!features) return issues;
  const roles = new Set(features.roles.map((role) => role.key));
  for (const screen of value.screens) {
    if (!roles.has(screen.role)) issues.push({ key: screen.key, message: `У экрана «${screen.title}» не выбрано, для какой роли он.` });
    if (!screen.blocks.length) issues.push({ key: screen.key, message: `На экране «${screen.title}» нет ни одного блока.` });
  }
  for (const role of features.roles) {
    if (!value.screens.some((screen) => screen.role === role.key)) issues.push({ key: 'screens', message: `Для роли «${role.name}» нет ни одного экрана.` });
  }
  for (const feature of features.features.filter((item) => item.priority === 'must')) {
    if (!value.screens.some((screen) => screen.features.includes(feature.key))) issues.push({ key: 'screens', message: `Обязательная функция «${feature.title}» не показана ни на одном экране.` });
  }
  return issues;
}

/** Roles from the people of the process; functions from its scenarios, one acceptance criterion per step. */
export function templateFeatures(brief: Brief | null, process: BusinessProcess | null): AppFeatures {
  const people = (process?.actors ?? []).filter((actor) => actor.kind === 'client' || actor.kind === 'business' || actor.kind === 'staff');
  const roles: AppRole[] = people.length
    ? people.slice(0, APP_LIMITS.roles).map((actor) => ({ key: actor.key.slice(0, 24), name: actor.name.slice(0, 40), description: actor.kind === 'client' ? tr('Пользуется приложением как клиент.') : actor.kind === 'staff' ? tr('Работает с заявками и данными.') : tr('Управляет приложением и видит всё.') }))
    : [{ key: 'user', name: tr('Пользователь'), description: brief?.audience?.slice(0, 200) ?? '' }, { key: 'admin', name: tr('Администратор'), description: tr('Управляет приложением и видит всё.') }];
  const roleKeys = new Set(roles.map((role) => role.key));
  const features: AppFeature[] = [{ key: 'signin', title: tr('Вход в аккаунт'), description: tr('Регистрация, вход и выход; восстановление пароля.'), roles: roles.map((role) => role.key), priority: 'must', acceptance: [tr('Можно зарегистрироваться, войти и выйти.'), tr('Пароль можно восстановить по почте.'), tr('Каждый видит только то, что разрешено его роли.')] }];
  for (const scenario of (process?.scenarios ?? []).slice(0, APP_LIMITS.features - 1)) {
    const actors = [...new Set(scenario.steps.map((step) => step.actor))].filter((key) => roleKeys.has(key));
    features.push({
      key: `f_${scenario.key}`.slice(0, 24), title: scenario.title.slice(0, 80), description: scenario.goal.slice(0, 400), roles: actors.length ? actors : [roles[0]!.key], priority: features.length <= 3 ? 'must' : 'should',
      acceptance: scenario.steps.filter((step) => step.capability !== 'offline').slice(0, APP_LIMITS.acceptance).map((step) => tr('{0}: {1}', [process!.actors.find((actor) => actor.key === step.actor)?.name ?? step.actor, step.action]).slice(0, 200)),
    });
  }
  return normalizeFeatures({ roles, features, sensitivity: 'personal', integrations: [] });
}

/** A home screen per role, then one screen per function that role uses; links go from the home screen. */
export function templateScreens(features: AppFeatures | null): AppScreens {
  const value = features ?? templateFeatures(null, null);
  const screens: AppScreen[] = [];
  for (const role of value.roles) {
    const own = value.features.filter((feature) => feature.roles.includes(role.key) && feature.key !== 'signin');
    const home = `home_${role.key}`.slice(0, 24);
    const children = own.slice(0, 4).map((feature) => ({
      key: `${role.key}_${feature.key}`.slice(0, 24), title: feature.title.slice(0, 60), role: role.key, purpose: feature.description.slice(0, 300), features: [feature.key],
      blocks: [{ kind: 'list' as const, title: feature.title.slice(0, 80), fields: [tr('Название'), tr('Дата'), tr('Статус')] }, { kind: 'form' as const, title: tr('Новая запись'), fields: [tr('Название'), tr('Описание')] }],
      links: [home],
    }));
    screens.push({
      key: home, title: tr('Главная — {0}', [role.name]).slice(0, 60), role: role.key, purpose: role.description.slice(0, 300), features: ['signin'],
      blocks: [{ kind: 'stats', title: tr('Коротко'), fields: own.slice(0, 3).map((feature) => feature.title.slice(0, 60)) }, { kind: 'actions', title: tr('Что можно сделать'), fields: own.slice(0, 4).map((feature) => feature.title.slice(0, 60)) }],
      links: children.map((child) => child.key),
    }, ...children);
  }
  return normalizeScreens({ screens: screens.slice(0, APP_LIMITS.screens) });
}

// ---- Clickable prototype: plain HTML pages, no scripts, links between screens. ----

function block(item: ScreenBlock, links: AppScreen[]): string {
  const fields = item.fields.length ? item.fields : [tr('Поле')];
  const title = item.title ? `<h2>${escapeHtml(item.title)}</h2>` : '';
  switch (item.kind) {
    case 'list': return `<section class="block">${title}<ul class="rows">${[1, 2, 3].map(() => `<li>${fields.map((field, index) => `<span class="${index ? 'muted' : ''}">${escapeHtml(field)}</span>`).join('')}</li>`).join('')}</ul></section>`;
    case 'table': return `<section class="block">${title}<div class="scroll"><table><thead><tr>${fields.map((field) => `<th scope="col">${escapeHtml(field)}</th>`).join('')}</tr></thead><tbody>${[1, 2, 3].map(() => `<tr>${fields.map(() => '<td>—</td>').join('')}</tr>`).join('')}</tbody></table></div></section>`;
    case 'form': return `<section class="block">${title}<form class="form">${fields.map((field) => `<label>${escapeHtml(field)}<input disabled placeholder="${escapeHtml(field)}"></label>`).join('')}<button type="button" disabled>${tr('Сохранить')}</button></form></section>`;
    case 'details': return `<section class="block">${title}<dl>${fields.map((field) => `<dt>${escapeHtml(field)}</dt><dd>—</dd>`).join('')}</dl></section>`;
    case 'stats': return `<section class="block">${title}<div class="stats">${fields.map((field) => `<div><strong>—</strong><span>${escapeHtml(field)}</span></div>`).join('')}</div></section>`;
    case 'search': return `<section class="block">${title}<div class="search"><input disabled placeholder="${tr('Поиск')}">${fields.map((field) => `<span class="chip">${escapeHtml(field)}</span>`).join('')}</div></section>`;
    case 'actions': {
      // An action button opens the screen of that function when there is one.
      const buttons = fields.map((field) => {
        const target = links.find((screen) => screen.title === field) ?? null;
        return target ? `<a class="button" href="${pageOf(target.key)}">${escapeHtml(field)}</a>` : `<span class="button ghost">${escapeHtml(field)}</span>`;
      });
      return `<section class="block">${title}<div class="actions">${buttons.join('')}</div></section>`;
    }
    default: return `<section class="block">${title}<p class="muted">${fields.map(escapeHtml).join(' · ')}</p></section>`;
  }
}

export const pageOf = (key: string) => `${key}.html`;

const prototypeCss = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f8;color:#0f1a24}
.banner{background:#fff3dc;color:#7a4b00;padding:8px 16px;font-size:14px}.top{background:#fff;border-bottom:1px solid #e1e5ea;padding:12px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.top strong{margin-right:auto}.top a{color:#0c5c38;text-decoration:none;font-size:14px}.top a[aria-current]{font-weight:700;text-decoration:underline}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:26px;margin:8px 0}.purpose{color:#52606d;margin:0 0 16px}
.block{background:#fff;border:1px solid #e1e5ea;border-radius:14px;padding:14px 16px;margin:0 0 12px}.block h2{font-size:17px;margin:0 0 10px}
.rows{list-style:none;margin:0;padding:0}.rows li{display:flex;gap:12px;flex-wrap:wrap;padding:10px 0;border-top:1px solid #eef1f4}.rows li:first-child{border-top:0}
.muted{color:#52606d}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #eef1f4;padding:8px;text-align:left}
.form{display:grid;gap:10px}.form label{display:grid;gap:4px;font-weight:600;font-size:14px}input{font:inherit;padding:10px;border:1px solid #c8cfd8;border-radius:10px;background:#f9fafb}
button,.button{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:10px;border:0;background:#13804f;color:#fff;font:inherit;font-weight:600;text-decoration:none}
.button.ghost{background:#e3f3ea;color:#0c5c38}.actions{display:flex;gap:8px;flex-wrap:wrap}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:#52606d}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.stats div{background:#f4f6f8;border-radius:10px;padding:10px;display:grid}.stats strong{font-size:22px}
.search{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.search input{flex:1 1 200px}.chip{background:#eef1f4;border-radius:999px;padding:4px 10px;font-size:14px}
nav.screens{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 0}nav.screens a{background:#fff;border:1px solid #e1e5ea;border-radius:999px;padding:6px 12px;color:#0f1a24;text-decoration:none;font-size:14px}`;

/** One page per screen; the role switch at the top lets the owner walk through the product as each role. */
export function renderPrototype(input: { brief: Brief | null; features: AppFeatures | null; screens: AppScreens; locale: string }): Array<{ path: string; title: string; html: string }> {
  return runWithLocale(contentLocale(input.locale), () => {
    const roles = input.features?.roles ?? [];
    const name = input.brief?.businessName || tr('Приложение');
    return input.screens.screens.map((screen) => {
      const role = roles.find((item) => item.key === screen.role);
      const sameRole = input.screens.screens.filter((item) => item.role === screen.role);
      const firstOf = (key: string) => input.screens.screens.find((item) => item.role === key);
      const switcher = roles.map((item) => { const first = firstOf(item.key); return first ? `<a href="${pageOf(first.key)}"${item.key === screen.role ? ' aria-current="true"' : ''}>${escapeHtml(item.name)}</a>` : ''; }).join('');
      const linked = screen.links.map((key) => input.screens.screens.find((item) => item.key === key)).filter((item): item is AppScreen => Boolean(item));
      const nav = sameRole.filter((item) => item.key !== screen.key).map((item) => `<a href="${pageOf(item.key)}">${escapeHtml(item.title)}</a>`).join('');
      const html = `<!doctype html><html lang="${escapeHtml(contentLocale(input.locale))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(screen.title)} — ${escapeHtml(name)}</title><style>${prototypeCss}</style></head><body>
<p class="banner">${tr('Прототип: экраны без настоящих данных и логики. Кнопки и ссылки показывают переходы между экранами.')}</p>
<header class="top"><strong>${escapeHtml(name)}</strong>${switcher}</header>
<main><p class="muted">${escapeHtml(role?.name ?? '')}</p><h1>${escapeHtml(screen.title)}</h1>${screen.purpose ? `<p class="purpose">${escapeHtml(screen.purpose)}</p>` : ''}
${screen.blocks.map((item) => block(item, linked)).join('\n')}
${linked.length ? `<nav class="screens" aria-label="${tr('Переходы')}">${linked.map((item) => `<a href="${pageOf(item.key)}">→ ${escapeHtml(item.title)}</a>`).join('')}</nav>` : ''}
${nav ? `<nav class="screens" aria-label="${tr('Другие экраны роли')}">${nav}</nav>` : ''}
</main></body></html>`;
      return { path: pageOf(screen.key), title: screen.title, html };
    });
  });
}

// ---- Architecture of a web application ----

const slug = (value: string) => pathFor(value).slice(1).replace(/-/g, '_') || 'item';
const plural = (value: string) => `${slug(value)}s`;

function entitiesOf(process: BusinessProcess | null, features: AppFeatures): ProcessEntity[] {
  const own = (process?.data ?? []).filter((entity) => entity.key !== 'user');
  const roles = features.roles.map((role) => role.name).join(' · ');
  return [{ key: 'user', name: tr('Пользователь'), fields: [tr('Имя'), tr('Почта'), roles ? tr('Роль: {0}', [roles]) : tr('Роль')], links: [] }, ...own].slice(0, 12);
}

export function appApiContract(name: string, entities: ProcessEntity[], features: AppFeatures): string {
  const lines = ['openapi: 3.1.0', 'info:', `  title: ${JSON.stringify(`${name} API`)}`, `  version: ${JSON.stringify(WEBAPP_VERSION)}`,
    `  description: ${JSON.stringify(tr('Черновик контракта для разработчика: ресурсы из схемы данных, вход и роли. Права по ролям — в таблице прав пакета; разработчик уточняет поля и ошибки.'))}`,
    'components:', '  securitySchemes:', '    session: { type: apiKey, in: cookie, name: session }', '  schemas:'];
  for (const entity of entities) {
    lines.push(`    ${slug(entity.name)}:`, '      type: object', `      description: ${JSON.stringify(entity.name)}`, '      properties:', '        id: { type: string, format: uuid, readOnly: true }');
    for (const field of entity.fields) lines.push(`        ${slug(field)}: { type: string, description: ${JSON.stringify(field)} }`);
    for (const link of entity.links) lines.push(`        ${slug(link.to)}${link.kind === 'many' ? '_ids' : '_id'}: ${link.kind === 'many' ? '{ type: array, items: { type: string, format: uuid }' : '{ type: string, format: uuid'}, description: ${JSON.stringify(link.label)} }`);
  }
  lines.push('security: [{ session: [] }]', 'paths:',
    '  /api/auth/register:', `    post: { summary: ${JSON.stringify(tr('Регистрация'))}, security: [], responses: { '201': { description: Created } } }`,
    '  /api/auth/login:', `    post: { summary: ${JSON.stringify(tr('Вход'))}, security: [], responses: { '200': { description: OK } } }`,
    '  /api/auth/logout:', `    post: { summary: ${JSON.stringify(tr('Выход'))}, responses: { '204': { description: Done } } }`,
    '  /api/me:', `    get: { summary: ${JSON.stringify(tr('Текущий пользователь и его роль ({0})', [features.roles.map((role) => role.key).join(', ')]))}, responses: { '200': { description: OK } } }`);
  for (const entity of entities.filter((item) => item.key !== 'user')) {
    const ref = `{ $ref: '#/components/schemas/${slug(entity.name)}' }`;
    lines.push(`  /api/${plural(entity.name)}:`,
      `    get: { summary: ${JSON.stringify(tr('Список: {0}', [entity.name]))}, responses: { '200': { description: OK, content: { application/json: { schema: { type: array, items: ${ref} } } } } } }`,
      `    post: { summary: ${JSON.stringify(tr('Создать: {0}', [entity.name]))}, requestBody: { content: { application/json: { schema: ${ref} } } }, responses: { '201': { description: Created } } }`,
      `  /api/${plural(entity.name)}/{id}:`,
      '    parameters: [{ name: id, in: path, required: true, schema: { type: string, format: uuid } }]',
      `    get: { summary: ${JSON.stringify(tr('Открыть: {0}', [entity.name]))}, responses: { '200': { description: OK, content: { application/json: { schema: ${ref} } } }, '404': { description: Not found } } }`,
      `    patch: { summary: ${JSON.stringify(tr('Изменить: {0}', [entity.name]))}, requestBody: { content: { application/json: { schema: ${ref} } } }, responses: { '200': { description: OK } } }`,
      `    delete: { summary: ${JSON.stringify(tr('Удалить: {0}', [entity.name]))}, responses: { '204': { description: Deleted } } }`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildAppPlan(input: { brief: Brief | null; process: BusinessProcess | null; features: AppFeatures | null; screens: AppScreens | null }, ownerNotes: string | null): TechPlan {
  const features = input.features ?? templateFeatures(input.brief, input.process);
  const name = input.brief?.businessName || tr('Приложение');
  const entities = entitiesOf(input.process, features);
  const notifies = (input.process?.scenarios ?? []).some((scenario) => scenario.steps.some((step) => step.capability.startsWith('notify') || step.capability === 'remind_client'));
  const pays = (input.process?.scenarios ?? []).some((scenario) => scenario.steps.some((step) => step.capability === 'pay_online')) || features.sensitivity === 'payments';
  const item = (title: string, plain: string, technical: string): TechPlanItem => ({ title, plain, technical });
  const components: TechPlanItem[] = [
    item(tr('Веб-приложение'), tr('Экраны для каждой роли — работают в браузере на телефоне и компьютере.'), tr('Одностраничное или серверное веб-приложение; экраны и переходы — по прототипу пакета.')),
    item(tr('Сервер приложения (API)'), tr('Проверяет вход и права, сохраняет и выдаёт данные.'), tr('HTTP API по контракту api.yaml пакета; проверка роли на каждом запросе.')),
    item(tr('База данных'), tr('Хранит пользователей и всё из схемы данных.'), tr('Реляционная БД; таблицы по схеме данных, связи — внешние ключи.')),
    item(tr('Вход и роли'), tr('Регистрация, вход, восстановление пароля; каждый видит только своё.'), tr('Сессии в httpOnly cookie, хеширование паролей, разграничение по ролям: {0}.', [features.roles.map((role) => role.name).join(', ')])),
    ...(notifies ? [item(tr('Уведомления'), tr('Сообщения пользователям и вам о событиях.'), tr('Почта или Telegram; отправка через очередь, без потери при сбое.'))] : []),
    ...(pays ? [item(tr('Оплата'), tr('Приём денег через платёжный сервис.'), tr('Подключение платёжного провайдера; деньги не хранятся в приложении; требуется отдельная проверка безопасности.'))] : []),
    ...features.integrations.map((integration) => item(integration, tr('Внешний сервис, с которым связано приложение.'), tr('Интеграция по API сервиса; ключи — в секретах сервера, не в коде.'))),
  ];
  const dataModel: DataEntity[] = entities.map((entity) => ({ key: entity.key, name: entity.name, plain: entity.fields.join(', '), fields: entity.fields.map((field) => ({ name: field, type: tr('текст') })), links: entity.links }));
  const must = features.features.filter((feature) => feature.priority === 'must').slice(0, 4);
  const sequences: Sequence[] = must.map((feature) => {
    const role = features.roles.find((item) => item.key === feature.roles[0])?.name ?? tr('Пользователь');
    return { title: feature.title, participants: [role, tr('Веб-приложение'), 'API', tr('База данных')], messages: [
      { from: 0, to: 1, text: feature.title }, { from: 1, to: 2, text: tr('Запрос с проверкой роли') }, { from: 2, to: 3, text: tr('Чтение или запись данных') }, { from: 2, to: 1, text: tr('Ответ') }, { from: 1, to: 0, text: tr('Результат на экране') },
    ] };
  });
  const coverage = input.process ? input.process.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({
    scenario: scenario.title, actor: input.process!.actors.find((actor) => actor.key === step.actor)?.name ?? step.actor, action: step.action, capability: step.capability,
    status: step.capability === 'offline' ? 'manual' as const : 'not_built' as const,
    how: step.capability === 'offline' ? tr('Делается вручную, как и задумано.') : tr('Делает разработчик по пакету: BuildPath не пишет код приложения.'),
  }))) : null;
  return {
    planVersion: TECHPLAN_VERSION, kind: 'app',
    summary: tr('Веб-приложение «{0}» для ролей: {1}. BuildPath готовит пакет для разработки — функции с критериями приёмки, экраны с прототипом, схему данных и контракт API; код пишет разработчик.', [name, features.roles.map((role) => role.name).join(', ')]),
    components, dataModel, sequences, coverage,
    features: features.features.map((feature) => item(feature.title, feature.description, `${tr(priorityLabels[feature.priority])}; ${tr('роли')}: ${feature.roles.map((key) => features.roles.find((role) => role.key === key)?.name ?? key).join(', ')}`)),
    roles: features.roles.map((role) => item(role.name, role.description, tr('Роль «{0}» в API: {1}', [role.name, role.key]))),
    data: entities.map((entity) => item(entity.name, entity.fields.join(', '), tr('Таблица {0}', [plural(entity.name)]))),
    pages: (input.screens?.screens ?? []).map((screen) => ({ path: `/${screen.key}`, title: screen.title, plain: screen.purpose })),
    notifications: notifies ? [tr('События из бизнес-процесса, где кого-то уведомляют.')] : [],
    hosting: [{ option: tr('Выбирает разработчик'), plain: tr('Любой хостинг с сервером приложения и базой данных. Требования к данным — в разделе ограничений.') }],
    limits: [
      tr('BuildPath не пишет и не запускает код приложения: пакет передаётся разработчику (можно пригласить специалиста на этап «Пакет для разработки»).'),
      ...(features.sensitivity === 'payments' ? [tr('Платежи: только через платёжного провайдера, с отдельной проверкой безопасности.')] : []),
      ...(features.sensitivity === 'health' ? [tr('Особо чувствительные данные: нужны юридическая проверка и усиленная защита (шифрование, журнал доступа).')] : []),
      ...(features.sensitivity !== 'normal' ? [tr('Персональные данные: хранить в стране, которую требует закон для ваших клиентов; согласие и удаление по запросу.')] : []),
    ],
    api: appApiContract(name, entities, features),
    ownerNotes,
  };
}

// ---- Package for development ----

export interface HandoffCheck { id: string; status: 'passed' | 'warning' | 'failed'; title: string; details: string; required: boolean }
export interface HandoffArtifact {
  packageVersion: string;
  files: Array<{ name: string; mimeType: string; content: string }>;
  checks: HandoffCheck[];
  sourceVersionIds: Record<string, string>;
  compiledAt: string;
}

const md = (value: string) => value.replace(/[|\r\n]+/g, ' ');

export function handoffChecks(input: { features: AppFeatures | null; screens: AppScreens | null; plan: TechPlan | null }): HandoffCheck[] {
  const checks: HandoffCheck[] = [];
  const add = (id: string, required: boolean, ok: boolean, title: string, pass: string, fail: string, warnOnly = false) => checks.push({ id, required, title, status: ok ? 'passed' : warnOnly ? 'warning' : 'failed', details: ok ? pass : fail });
  const featureIssues = input.features ? featuresIssues(input.features) : [{ key: 'features', message: '' }];
  add('features', true, featureIssues.length === 0, tr('Функции и роли'), tr('У каждой функции есть роль и критерий приёмки.'), tr('Не всё заполнено на этапе «Функции и роли».'));
  const screenIssues = input.screens ? screensIssues(input.screens, input.features) : [{ key: 'screens', message: '' }];
  add('screens', true, screenIssues.length === 0, tr('Экраны'), tr('У каждой роли есть экраны, обязательные функции показаны.'), tr('Не всё заполнено на этапе «Экраны и прототип».'));
  add('plan', true, Boolean(input.plan && input.plan.kind === 'app' && input.plan.api), tr('Архитектура'), tr('Схема данных и контракт API составлены.'), tr('Примите этап «Архитектура».'));
  const orphan = (input.features?.features ?? []).filter((feature) => feature.priority !== 'later' && !(input.screens?.screens ?? []).some((screen) => screen.features.includes(feature.key)));
  add('screens-should', false, orphan.length === 0, tr('Желательные функции на экранах'), tr('Все функции первой версии есть на экранах.'), tr('Не показаны на экранах: {0}.', [orphan.map((feature) => `«${feature.title}»`).join(', ')]), true);
  const sensitive = input.features && input.features.sensitivity !== 'normal';
  add('security', false, !sensitive, tr('Требования к защите данных'), tr('Особых требований нет.'), tr('Приложение хранит чувствительные данные — в пакете есть требования к защите; нужна проверка безопасности перед запуском (ориентир — OWASP ASVS уровня 1).'), true);
  return checks;
}

export function buildHandoff(input: { brief: Brief | null; process: BusinessProcess | null; features: AppFeatures; screens: AppScreens; plan: TechPlan; locale: string; sourceVersionIds: Record<string, string> }): HandoffArtifact {
  return runWithLocale(contentLocale(input.locale), () => {
    const name = input.brief?.businessName || tr('Приложение');
    const roleName = (key: string) => input.features.roles.find((role) => role.key === key)?.name ?? key;
    const featureName = (key: string) => input.features.features.find((feature) => feature.key === key)?.title ?? key;
    const spec = [
      `# ${name} — ${tr('техническое задание')}`, '',
      input.brief?.whatYouDo ? `${input.brief.whatYouDo}\n` : '',
      `## ${tr('Роли')}`, '', ...input.features.roles.map((role) => `- **${role.name}** (\`${role.key}\`) — ${role.description}`), '',
      `## ${tr('Функции')}`, '',
      ...PRIORITIES.flatMap((priority) => {
        const own = input.features.features.filter((feature) => feature.priority === priority);
        return own.length ? [`### ${tr(priorityLabels[priority])}`, '', ...own.flatMap((feature) => [
          `#### ${feature.title}`, '', feature.description, '', `${tr('Кто пользуется')}: ${feature.roles.map(roleName).join(', ')}`, '', `${tr('Критерии приёмки')}:`, ...feature.acceptance.map((line) => `- [ ] ${line}`), '',
        ])] : [];
      }),
      `## ${tr('Экраны')}`, '', tr('Прототип — папка prototype/, откройте любой файл в браузере.'), '',
      ...input.screens.screens.flatMap((screen) => [`### ${screen.title} (${roleName(screen.role)})`, '', screen.purpose, '',
        ...screen.blocks.map((item) => `- ${tr(blockLabels[item.kind])}${item.title ? ` «${item.title}»` : ''}: ${item.fields.join(', ')}`),
        screen.features.length ? `- ${tr('Функции')}: ${screen.features.map(featureName).join(', ')}` : '', '']),
      `## ${tr('Бизнес-правила')}`, '', ...(input.process?.rules ?? []).map((rule) => `- ${rule}`), '',
      `## ${tr('Данные и защита')}`, '', `${tr('Чувствительность')}: ${tr(sensitivityLabels[input.features.sensitivity])}`, '', ...input.plan.limits.map((line) => `- ${line}`), '',
      input.features.integrations.length ? `## ${tr('Интеграции')}\n\n${input.features.integrations.map((line) => `- ${line}`).join('\n')}\n` : '',
      input.plan.ownerNotes ? `## ${tr('Заметки владельца')}\n\n${input.plan.ownerNotes}\n` : '',
      `---\n${tr('Пакет BuildPath {0}. Составлен из принятых этапов; код приложения не создавался и не проверялся.', [WEBAPP_VERSION])}`,
    ].join('\n');
    const matrix = [`# ${tr('Права по ролям')}`, '', `| ${tr('Функция')} | ${input.features.roles.map((role) => md(role.name)).join(' | ')} |`, `|---|${input.features.roles.map(() => '---').join('|')}|`,
      ...input.features.features.map((feature) => `| ${md(feature.title)} | ${input.features.roles.map((role) => (feature.roles.includes(role.key) ? '✓' : '')).join(' | ')} |`), ''].join('\n');
    const er = ['```mermaid', 'erDiagram', ...input.plan.dataModel.map((entity) => `  ${slug(entity.name).toUpperCase()} {\n${entity.fields.map((field) => `    string ${slug(field.name)}`).join('\n')}\n  }`),
      ...input.plan.dataModel.flatMap((entity) => entity.links.map((link) => {
        const target = input.plan.dataModel.find((item) => item.key === link.to);
        return target ? `  ${slug(entity.name).toUpperCase()} ||--${link.kind === 'many' ? 'o{' : 'o|'} ${slug(target.name).toUpperCase()} : "${link.label.replace(/"/g, "'")}"` : '';
      }).filter(Boolean)), '```'].join('\n');
    const stories = [`# ${tr('Пользовательские истории')}`, '', ...input.features.features.flatMap((feature) => feature.roles.map((role) => `- ${tr('Как {0}, я хочу: {1} — чтобы {2}', [roleName(role), feature.title.toLowerCase(), feature.description || tr('решить свою задачу')])}`)), ''].join('\n');
    const prototype = renderPrototype({ brief: input.brief, features: input.features, screens: input.screens, locale: input.locale }).map((page) => ({ name: `prototype/${page.path}`, mimeType: 'text/html', content: page.html }));
    const readme = [`# ${name}`, '', tr('Пакет для разработки, собранный в BuildPath. Начните с ТЗ.'), '',
      `- spec.md — ${tr('техническое задание: роли, функции с критериями приёмки, экраны, правила')}`,
      `- permissions.md — ${tr('права по ролям')}`, `- data-model.md — ${tr('схема данных (Mermaid)')}`, `- user-stories.md — ${tr('пользовательские истории')}`,
      `- api.yaml — ${tr('черновик контракта API (OpenAPI 3.1)')}`, `- prototype/ — ${tr('кликабельный прототип экранов')}`, ''].join('\n');
    return {
      packageVersion: WEBAPP_VERSION,
      files: [
        { name: 'README.md', mimeType: 'text/markdown', content: readme },
        { name: 'spec.md', mimeType: 'text/markdown', content: spec.replace(/\n{3,}/g, '\n\n') },
        { name: 'permissions.md', mimeType: 'text/markdown', content: matrix },
        { name: 'data-model.md', mimeType: 'text/markdown', content: `# ${tr('Схема данных')}\n\n${er}\n` },
        { name: 'user-stories.md', mimeType: 'text/markdown', content: stories },
        { name: 'api.yaml', mimeType: 'application/yaml', content: input.plan.api },
        ...prototype,
      ],
      checks: handoffChecks({ features: input.features, screens: input.screens, plan: input.plan }),
      sourceVersionIds: input.sourceVersionIds,
      compiledAt: new Date().toISOString(),
    };
  });
}

/** Plain-language changes between two versions, for change notices: by key, so renaming is «changed», not «removed and added». */
export function featuresChanges(before: AppFeatures, after: AppFeatures): string[] {
  const lines: string[] = [];
  const diff = <T extends { key: string }>(was: T[], now: T[], name: (item: T) => string, kind: string, same: (a: T, b: T) => boolean) => {
    for (const item of now) {
      const old = was.find((other) => other.key === item.key);
      if (!old) lines.push(tr('Добавлено ({0}): «{1}»', [kind, name(item)]));
      else if (!same(old, item)) lines.push(tr('Изменено ({0}): «{1}»', [kind, name(item)]));
    }
    for (const item of was) if (!now.some((other) => other.key === item.key)) lines.push(tr('Убрано ({0}): «{1}»', [kind, name(item)]));
  };
  diff(before.roles ?? [], after.roles ?? [], (role) => role.name, tr('роль'), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  diff(before.features ?? [], after.features ?? [], (feature) => feature.title, tr('функция'), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  if (before.sensitivity !== after.sensitivity) lines.push(tr('Данные: {0}', [tr(sensitivityLabels[after.sensitivity] ?? after.sensitivity)]));
  if (JSON.stringify(before.integrations) !== JSON.stringify(after.integrations)) lines.push(tr('Изменены интеграции'));
  return lines;
}

export function screensChanges(before: AppScreens, after: AppScreens): string[] {
  const lines: string[] = [];
  for (const screen of after.screens ?? []) {
    const old = (before.screens ?? []).find((item) => item.key === screen.key);
    if (!old) lines.push(tr('Добавлен экран «{0}»', [screen.title]));
    else if (JSON.stringify(old) !== JSON.stringify(screen)) lines.push(tr('Изменён экран «{0}»', [screen.title]));
  }
  for (const screen of before.screens ?? []) if (!(after.screens ?? []).some((item) => item.key === screen.key)) lines.push(tr('Убран экран «{0}»', [screen.title]));
  return lines;
}
