// «Контракты» of a web application (builder-docs PRODUCT_LIFECYCLE.md §4.7): the borders that let different people or AI
// agents build modules at the same time without breaking each other. Drafted from the architecture's data schema, the ТЗ's
// access matrix and features: modules and what each owns, API operations with who may call them and their errors, events
// and notifications, calls to outside services with what happens when they fail. From it the platform writes an OpenAPI 3.1
// contract and a database migration. The owner approves it as a contract (STAGE_WORK_MODEL §22).
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import { expandedSchema, type ArchitectureDesign, type FieldType } from './architecture.js';
import type { BusinessProcess } from './process.js';
import type { AccessAction } from './spec-extras.js';
import type { AppFeatures } from './webapp.js';

export const CONTRACTS_VERSION = '1.0.0';
export const CONTRACT_LIMITS = { modules: 12, operations: 80, errors: 8, events: 30, integrations: 10, text: 300 };
export const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];
export const CHANNELS = ['email', 'messenger', 'sms', 'push', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ContractModule { key: string; name: string; owns: string[]; features: string[] }
export interface OperationError { status: number; code: string; when: string }
export interface ContractOperation {
  key: string; module: string; method: Method; path: string; summary: string;
  /** The ТЗ feature this operation serves; null for platform operations (sign-in, the current user). */
  feature: string | null;
  /** Role keys allowed to call it; empty means anyone, signed in or not — only for sign-up and sign-in. */
  roles: string[];
  /** The record it works with and what it does with it, to check against the access matrix. */
  entity: string | null; action: AccessAction | 'other';
  errors: OperationError[];
}
export interface ContractEvent { key: string; module: string; name: string; when: string; to: string; channel: Channel }
export interface ContractIntegration { key: string; service: string; call: string; onError: string }
export interface Contracts { modules: ContractModule[]; operations: ContractOperation[]; events: ContractEvent[]; integrations: ContractIntegration[] }

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
const keys = (value: unknown, max: number) => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(item)))].slice(0, max) : []);
function keyer(prefix: string) {
  const used = new Set<string>();
  return (value: unknown, index: number) => {
    let key = typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value) ? value : `${prefix}${index + 1}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    return key;
  };
}
/** A path the contract can carry: lowercase segments and {id}; nothing that could break the YAML it is written into. */
const PATH = /^\/api(\/([a-z0-9_-]{1,40}|\{id\}))+$/;

export function normalizeContracts(raw: unknown): Contracts {
  const value = isRecord(raw) ? raw : {};
  const moduleKey = keyer('m');
  const modules = list(value.modules, 'modules', CONTRACT_LIMITS.modules).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:modules.${index}`);
    return { key: item.key, name: text(item.name, `modules.${index}.name`, 60), owns: keys(item.owns, 20), features: keys(item.features, 40) };
  }).filter((item) => item.name).map((item, index) => ({ ...item, key: moduleKey(item.key, index) }));
  const moduleKeys = new Set(modules.map((item) => item.key));
  const operationKey = keyer('op');
  const operations = list(value.operations, 'operations', CONTRACT_LIMITS.operations).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:operations.${index}`);
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (!PATH.test(path)) throw new ArtifactValidationError(`FIELD_INVALID:operations.${index}.path`);
    const errors = list(item.errors, `operations.${index}.errors`, CONTRACT_LIMITS.errors).map((error, n) => {
      if (!isRecord(error)) throw new ArtifactValidationError(`FIELD_INVALID:operations.${index}.errors.${n}`);
      const status = Number(error.status);
      return { status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400, code: (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'ERROR'), when: text(error.when, `operations.${index}.errors.${n}.when`, CONTRACT_LIMITS.text) };
    });
    return {
      key: item.key, module: typeof item.module === 'string' && moduleKeys.has(item.module) ? item.module : (modules[0]?.key ?? ''),
      method: (METHODS as readonly unknown[]).includes(item.method) ? item.method as Method : 'GET', path, summary: text(item.summary, `operations.${index}.summary`, 120),
      feature: typeof item.feature === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(item.feature) ? item.feature : null, roles: keys(item.roles, 10),
      entity: typeof item.entity === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(item.entity) ? item.entity : null,
      action: (['view', 'create', 'edit', 'delete', 'other'] as const).includes(item.action as never) ? item.action as ContractOperation['action'] : 'other', errors,
    };
  }).filter((item) => item.module).map((item, index) => ({ ...item, key: operationKey(item.key, index) }));
  const eventKey = keyer('ev');
  const events = list(value.events, 'events', CONTRACT_LIMITS.events).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:events.${index}`);
    return { key: item.key, module: typeof item.module === 'string' && moduleKeys.has(item.module) ? item.module : (modules[0]?.key ?? ''), name: text(item.name, `events.${index}.name`, 80), when: text(item.when, `events.${index}.when`, CONTRACT_LIMITS.text), to: text(item.to, `events.${index}.to`, 80), channel: (CHANNELS as readonly unknown[]).includes(item.channel) ? item.channel as Channel : 'in_app' };
  }).filter((item) => item.name && item.module).map((item, index) => ({ ...item, key: eventKey(item.key, index) }));
  const integrationKey = keyer('in');
  const integrations = list(value.integrations, 'integrations', CONTRACT_LIMITS.integrations).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:integrations.${index}`);
    return { key: item.key, service: text(item.service, `integrations.${index}.service`, 80), call: text(item.call, `integrations.${index}.call`, CONTRACT_LIMITS.text), onError: text(item.onError, `integrations.${index}.onError`, CONTRACT_LIMITS.text) };
  }).filter((item) => item.service).map((item, index) => ({ ...item, key: integrationKey(item.key, index) }));
  return { modules, operations, events, integrations };
}

/** A URL segment from a record: its key, as the API names resources. */
const resource = (key: string) => key.replace(/_/g, '-').slice(0, 40);

/** The first contracts without AI: a module per record, its operations as the access matrix allows, events from the process. */
export function templateContracts(input: { design: ArchitectureDesign; features: AppFeatures; process: BusinessProcess | null }): Contracts {
  const { design, features, process } = input;
  const schema = expandedSchema(design.schema).filter((entity) => !entity.junction);
  const access = features.access ?? [];
  const modules: ContractModule[] = [{ key: 'accounts', name: tr('Аккаунты'), owns: ['user'], features: [] }];
  for (const entity of schema.filter((item) => item.key !== 'user')) modules.push({ key: `m_${entity.key}`.slice(0, 32), name: entity.name, owns: [entity.key], features: [] });
  const moduleOf = (entity: string) => modules.find((item) => item.owns.includes(entity))?.key ?? 'accounts';
  // A feature belongs to the module of the first record it works with; platform rules go to accounts.
  for (const feature of features.features) {
    const owner = moduleOf(feature.data?.[0] ?? 'user');
    modules.find((item) => item.key === owner)!.features.push(feature.key);
  }
  const rolesFor = (entity: string, action: AccessAction) => access.filter((row) => row.data === entity && row.actions.includes(action)).map((row) => row.role);
  const featureFor = (entity: string) => features.features.find((feature) => (feature.data ?? []).includes(entity))?.key ?? null;
  const unique = (entity: string) => schema.find((item) => item.key === entity)?.fields.some((field) => field.unique) ?? false;
  const own = (entity: string, role: string) => access.find((row) => row.data === entity && row.role === role)?.scope === 'own';
  const operations: ContractOperation[] = [
    { key: 'register', module: 'accounts', method: 'POST', path: '/api/auth/register', summary: tr('Регистрация'), feature: features.features.find((feature) => feature.key === 'signin')?.key ?? null, roles: [], entity: 'user', action: 'create',
      errors: [{ status: 400, code: 'VALIDATION', when: tr('Почта или пароль не подходят по правилам') }, { status: 409, code: 'EMAIL_TAKEN', when: tr('Такая почта уже зарегистрирована') }, { status: 429, code: 'TOO_MANY_REQUESTS', when: tr('Слишком много попыток подряд') }] },
    { key: 'login', module: 'accounts', method: 'POST', path: '/api/auth/login', summary: tr('Вход'), feature: features.features.find((feature) => feature.key === 'signin')?.key ?? null, roles: [], entity: 'user', action: 'other',
      errors: [{ status: 401, code: 'INVALID_CREDENTIALS', when: tr('Неверная почта или пароль — без уточнения, что именно') }, { status: 429, code: 'TOO_MANY_REQUESTS', when: tr('Слишком много попыток подряд') }] },
    { key: 'me', module: 'accounts', method: 'GET', path: '/api/me', summary: tr('Текущий пользователь и его роль'), feature: null, roles: features.roles.map((role) => role.key), entity: 'user', action: 'view',
      errors: [{ status: 401, code: 'UNAUTHENTICATED', when: tr('Пользователь не вошёл') }] },
  ];
  const signedIn = { status: 401, code: 'UNAUTHENTICATED', when: tr('Пользователь не вошёл') };
  const forbidden = { status: 403, code: 'FORBIDDEN', when: tr('Роли это не разрешено') };
  for (const entity of schema.filter((item) => item.key !== 'user')) {
    const base = `/api/${resource(entity.key)}`;
    const module = moduleOf(entity.key);
    const feature = featureFor(entity.key);
    const add = (method: Method, path: string, action: AccessAction, summary: string, extra: OperationError[]) => {
      const roles = rolesFor(entity.key, action);
      if (!roles.length) return;
      const scoped = roles.some((role) => own(entity.key, role));
      operations.push({ key: `${action}_${entity.key}${path.endsWith('{id}') && action === 'view' ? '_one' : ''}`.slice(0, 32), module, method, path, summary, feature, roles, entity: entity.key, action,
        errors: [signedIn, forbidden, ...(path.endsWith('{id}') ? [{ status: 404, code: 'NOT_FOUND', when: scoped ? tr('Записи нет или она чужая — ответ одинаковый, чтобы не выдавать чужие записи') : tr('Записи нет') }] : []), ...extra] });
    };
    add('GET', base, 'view', tr('Список: {0}', [entity.name]), []);
    add('GET', `${base}/{id}`, 'view', tr('Одна запись: {0}', [entity.name]), []);
    add('POST', base, 'create', tr('Создать: {0}', [entity.name]), [{ status: 400, code: 'VALIDATION', when: tr('Не заполнено обязательное поле или значение не того типа') }, ...(unique(entity.key) ? [{ status: 409, code: 'DUPLICATE', when: tr('Такое значение уже есть, а оно не должно повторяться') }] : [])]);
    add('PATCH', `${base}/{id}`, 'edit', tr('Изменить: {0}', [entity.name]), [{ status: 400, code: 'VALIDATION', when: tr('Значение не того типа') }, { status: 409, code: 'CONFLICT', when: tr('Запись уже изменил кто-то другой') }]);
    add('DELETE', `${base}/{id}`, 'delete', tr('Удалить: {0}', [entity.name]), [{ status: 409, code: 'IN_USE', when: tr('На запись ссылаются другие записи') }]);
  }
  // Events: the steps of the process where someone is told something.
  const channel: Channel = design.components.some((item) => item.kind === 'messenger') ? 'messenger' : design.components.some((item) => item.kind === 'email') ? 'email' : 'in_app';
  const events: ContractEvent[] = [];
  for (const scenario of process?.scenarios ?? []) for (const step of scenario.steps) {
    if (!(step.capability.startsWith('notify') || step.capability === 'remind_client')) continue;
    // The step's actor is who sends (often the application); who receives follows from the capability.
    const kind = step.capability === 'remind_client' ? 'client' : step.capability === 'notify_master' ? 'staff' : 'business';
    const to = process!.actors.find((actor) => actor.kind === kind)?.name ?? tr('Владелец');
    events.push({ key: `ev_${scenario.key}_${step.key}`.slice(0, 32), module: modules[1]?.key ?? 'accounts', name: step.action.slice(0, 80), when: tr('Сценарий «{0}»', [scenario.title]).slice(0, 300), to, channel });
  }
  const integrations: ContractIntegration[] = (features.services ?? []).map((service, index) => ({
    key: `in${index + 1}`, service: service.name, call: service.purpose || tr('Вызов по API сервиса'),
    onError: /оплат|pay|kaspi/i.test(service.name) ? tr('Заказ остаётся «ожидает оплаты»; статус меняет только подтверждение сервиса. Клиент видит, что оплата не прошла, и может повторить.') : tr('Повторить до 3 раз с паузой; потом записать в журнал и сообщить владельцу. Основное действие пользователя не отменяется.'),
  }));
  return normalizeContracts({ modules, operations: operations.slice(0, CONTRACT_LIMITS.operations), events: events.slice(0, CONTRACT_LIMITS.events), integrations });
}

export interface ContractIssue { code: string; severity: 'blocking' | 'important' | 'minor'; target: string; message: string; fix: string }

/** What the contracts owe the ТЗ and the architecture, and what makes them unusable as a contract. */
export function contractIssues(value: Contracts, features: AppFeatures | null, design: ArchitectureDesign | null): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const seen = new Map<string, string>();
  for (const operation of value.operations) {
    const id = `${operation.method} ${operation.path}`;
    if (seen.has(id)) issues.push({ code: 'CONTRACT_DUPLICATE_OPERATION', severity: 'blocking', target: operation.key, message: tr('Операция {0} описана дважды.', [id]), fix: tr('Оставьте одну: два одинаковых адреса нельзя реализовать.') });
    seen.set(id, operation.key);
  }
  for (const feature of (features?.features ?? []).filter((item) => item.priority !== 'later')) {
    const covered = value.operations.some((operation) => operation.feature === feature.key) || (feature.data ?? []).some((entity) => value.operations.some((operation) => operation.entity === entity));
    if (!covered) issues.push({ code: 'CONTRACT_FEATURE_NOT_COVERED', severity: 'important', target: 'operations', message: tr('Функция «{0}» не покрыта ни одной операцией API.', [feature.title]), fix: tr('Добавьте операцию и укажите у неё эту функцию.') });
  }
  const access = features?.access ?? [];
  for (const operation of value.operations) {
    const open = operation.path === '/api/auth/register' || operation.path === '/api/auth/login';
    if (!open && !operation.roles.length) issues.push({ code: 'CONTRACT_OPERATION_OPEN', severity: 'important', target: operation.key, message: tr('Операцию {0} {1} может вызвать кто угодно — права не указаны.', [operation.method, operation.path]), fix: tr('Укажите роли из матрицы «кто что может».') });
    if (operation.entity && operation.action !== 'other' && operation.entity !== 'user') {
      for (const role of operation.roles) {
        const row = access.find((item) => item.role === role && item.data === operation.entity);
        if (!row || !row.actions.includes(operation.action)) issues.push({ code: 'CONTRACT_ROLE_NOT_ALLOWED', severity: 'important', target: operation.key, message: tr('Операция {0} {1} разрешена роли «{2}», а в ТЗ этой роли такое не разрешено.', [operation.method, operation.path, features?.roles.find((item) => item.key === role)?.name ?? role]), fix: tr('Уберите роль из операции или разрешите это в ТЗ на вкладке «Кто что может».') });
      }
    }
    if (!operation.errors.length) issues.push({ code: 'CONTRACT_NO_ERRORS', severity: 'minor', target: operation.key, message: tr('У операции {0} {1} не описаны ошибки.', [operation.method, operation.path]), fix: tr('Хотя бы «не вошёл», «нет прав» и «неверные данные».') });
    else if (operation.path.endsWith('{id}') && !operation.errors.some((error) => error.status === 404)) issues.push({ code: 'CONTRACT_NO_NOT_FOUND', severity: 'minor', target: operation.key, message: tr('У операции {0} {1} нет ответа «записи нет».', [operation.method, operation.path]), fix: tr('Добавьте ошибку 404.') });
  }
  // Every record of the schema has exactly one owner module.
  const owners = new Map<string, string[]>();
  for (const module of value.modules) for (const entity of module.owns) owners.set(entity, [...(owners.get(entity) ?? []), module.name]);
  for (const [entity, names] of owners) if (names.length > 1) issues.push({ code: 'CONTRACT_TWO_OWNERS', severity: 'important', target: 'modules', message: tr('Запись «{0}» принадлежит сразу модулям: {1}.', [entity, names.join(', ')]), fix: tr('Оставьте одного владельца; другие модули работают с ней через его операции.') });
  for (const entity of (design?.schema.entities ?? []).filter((item) => !owners.has(item.key))) issues.push({ code: 'CONTRACT_NO_OWNER', severity: 'minor', target: 'modules', message: tr('У записи «{0}» нет модуля-владельца.', [entity.name]), fix: tr('Назначьте её одному модулю.') });
  for (const integration of value.integrations) if (!integration.onError) issues.push({ code: 'CONTRACT_INTEGRATION_NO_FALLBACK', severity: 'important', target: integration.key, message: tr('Не сказано, что делать, если «{0}» не отвечает.', [integration.service]), fix: tr('Напишите: повторить, отложить, сообщить владельцу — и что видит пользователь.') });
  for (const service of features?.services ?? []) if (!value.integrations.some((item) => item.service === service.name)) issues.push({ code: 'CONTRACT_SERVICE_MISSING', severity: 'important', target: 'integrations', message: tr('Интеграция «{0}» из ТЗ не описана в контрактах.', [service.name]), fix: tr('Добавьте вызов и что делать при ошибке.') });
  return issues;
}

const yaml = (value: string) => JSON.stringify(value);

/** OpenAPI 3.1 from the contracts and the schema. Written by the platform: every value is quoted, paths are checked on input. */
export function contractsOpenApi(name: string, value: Contracts, design: ArchitectureDesign, features: AppFeatures): string {
  const schemaType: Record<FieldType, string> = { text: '{ type: string }', long_text: '{ type: string }', number: '{ type: number }', money: '{ type: string, pattern: "^-?\\\\d+(\\\\.\\\\d{1,2})?$" }', date: '{ type: string, format: date }', datetime: '{ type: string, format: date-time }', bool: '{ type: boolean }', status: '{ type: string }', email: '{ type: string, format: email }', phone: '{ type: string }', file: '{ type: string, format: uri }', ref: '{ type: string, format: uuid }' };
  const roleName = (key: string) => features.roles.find((role) => role.key === key)?.name ?? key;
  const lines = ['openapi: 3.1.0', 'info:', `  title: ${yaml(`${name} API`)}`, `  version: ${yaml(CONTRACTS_VERSION)}`, `  description: ${yaml(tr('Контракт BuildPath: операции, права по ролям (x-roles), ошибки. Утверждён владельцем — меняется только новой версией.'))}`,
    'servers:', `  - url: /`, `    description: ${yaml(tr('Адрес приложения; для теста и рабочей версии — свои'))}`, 'components:', '  securitySchemes:', '    session: { type: apiKey, in: cookie, name: session }', '  schemas:',
    '    Error:', '      type: object', '      required: [code]', '      properties:', '        code: { type: string }', '        message: { type: string }'];
  for (const entity of expandedSchema(design.schema)) {
    const required = entity.fields.filter((field) => field.required).map((field) => field.key);
    lines.push(`    ${entity.key}:`, '      type: object', `      description: ${yaml(entity.name)}`, ...(required.length ? [`      required: [${required.join(', ')}]`] : []), '      properties:', '        id: { type: string, format: uuid, readOnly: true }');
    for (const field of entity.fields) {
      const type = field.type === 'status' && field.options.length ? `{ type: string, enum: [${field.options.map(yaml).join(', ')}] }` : schemaType[field.type];
      lines.push(`        ${field.key}: ${type.replace(/ }$/, `, description: ${yaml(field.name)} }`)}`);
    }
  }
  lines.push('security: [{ session: [] }]', 'paths:');
  const byPath = new Map<string, ContractOperation[]>();
  for (const operation of value.operations) byPath.set(operation.path, [...(byPath.get(operation.path) ?? []), operation]);
  for (const [path, operations] of byPath) {
    lines.push(`  ${path}:`);
    if (path.includes('{id}')) lines.push('    parameters:', '      - { in: path, name: id, required: true, schema: { type: string, format: uuid } }');
    for (const operation of operations) {
      const body = (operation.method === 'POST' || operation.method === 'PATCH') && operation.entity && design.schema.entities.some((entity) => entity.key === operation.entity);
      const ok = operation.method === 'POST' ? '201' : operation.method === 'DELETE' ? '204' : '200';
      lines.push(`    ${operation.method.toLowerCase()}:`, `      operationId: ${operation.key}`, `      summary: ${yaml(operation.summary || `${operation.method} ${path}`)}`,
        `      tags: [${yaml(value.modules.find((module) => module.key === operation.module)?.name ?? operation.module)}]`,
        `      x-roles: [${operation.roles.map((role) => yaml(roleName(role))).join(', ')}]`,
        ...(operation.roles.length ? [] : ['      security: []']),
        ...(body ? ['      requestBody:', '        required: true', `        content: { application/json: { schema: { $ref: "#/components/schemas/${operation.entity}" } } }`] : []),
        '      responses:', `        '${ok}': { description: ${yaml(tr('Готово'))} }`,
        ...operation.errors.map((error) => `        '${error.status}': { description: ${yaml(`${error.code}: ${error.when}`)}, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }`));
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A first migration from the schema (PostgreSQL): tables with required, unique and status-checked columns, then foreign keys
 * added after every table exists — so the order of tables and links in both directions do not matter. A 1–N relation puts
 * the key on the «many» table, 1–1 makes it unique, N–N gets its link table.
 */
export function contractsMigration(design: ArchitectureDesign): string {
  const column: Record<FieldType, string> = { text: 'varchar(255)', long_text: 'text', number: 'numeric', money: 'numeric(14,2)', date: 'date', datetime: 'timestamptz', bool: 'boolean', status: 'varchar(40)', email: 'varchar(254)', phone: 'varchar(32)', file: 'text', ref: 'uuid' };
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const lines = [`-- ${tr('Первая миграция из схемы данных BuildPath. Проверьте перед применением.')}`, 'CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''];
  const keys: string[] = [];
  const extra = new Map<string, string[]>();
  for (const relation of design.schema.relations) {
    if (relation.kind === 'many_many') continue;
    const name = `${relation.from}_id`;
    extra.set(relation.to, [...(extra.get(relation.to) ?? []), `  "${name}" uuid${relation.kind === 'one_one' ? ' UNIQUE' : ''}`]);
    keys.push(`ALTER TABLE "${relation.to}" ADD FOREIGN KEY ("${name}") REFERENCES "${relation.from}" ("id");`);
  }
  for (const entity of expandedSchema(design.schema)) {
    const columns = ['  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid()'];
    for (const field of entity.fields) {
      const check = field.type === 'status' && field.options.length ? ` CHECK ("${field.key}" IN (${field.options.map(quote).join(', ')}))` : '';
      columns.push(`  "${field.key}" ${column[field.type]}${field.required ? ' NOT NULL' : ''}${field.unique ? ' UNIQUE' : ''}${check}`);
      if (field.type === 'ref' && field.ref) keys.push(`ALTER TABLE "${entity.key}" ADD FOREIGN KEY ("${field.key}") REFERENCES "${field.ref}" ("id")${entity.junction ? ' ON DELETE CASCADE' : ''};`);
    }
    columns.push(...(extra.get(entity.key) ?? []), '  "created_at" timestamptz NOT NULL DEFAULT now()');
    if (entity.junction) columns.push(`  UNIQUE ("${entity.fields[0]!.key}", "${entity.fields[1]!.key}")`);
    lines.push(`-- ${entity.name}`, `CREATE TABLE "${entity.key}" (`, columns.join(',\n'), ');', '');
  }
  return [...lines, ...keys, ''].join('\n');
}

export function contractsMarkdown(value: Contracts, features: AppFeatures | null): string {
  const roleName = (key: string) => features?.roles.find((role) => role.key === key)?.name ?? key;
  const featureName = (key: string | null) => (key ? features?.features.find((feature) => feature.key === key)?.title ?? key : '—');
  const channels: Record<Channel, string> = { email: tr('почта'), messenger: tr('мессенджер'), sms: 'SMS', push: 'push', in_app: tr('в приложении') };
  return [
    `# ${tr('Контракты')}`, '',
    `## ${tr('Модули')}`, '', ...value.modules.flatMap((module) => [`### ${module.name}`, '', `- ${tr('Владеет данными')}: ${module.owns.join(', ') || '—'}`, `- ${tr('Функции')}: ${module.features.map(featureName).join(', ') || '—'}`,
      `- ${tr('Операции')}: ${value.operations.filter((operation) => operation.module === module.key).map((operation) => `\`${operation.method} ${operation.path}\``).join(', ') || '—'}`, '']),
    `## ${tr('Операции')}`, '', `| ${tr('Операция')} | ${tr('Кто может')} | ${tr('Функция')} | ${tr('Ошибки')} |`, '|---|---|---|---|',
    ...value.operations.map((operation) => `| \`${operation.method} ${operation.path}\` ${operation.summary} | ${operation.roles.map(roleName).join(', ') || tr('все')} | ${featureName(operation.feature)} | ${operation.errors.map((error) => `${error.status} ${error.code}`).join(', ') || '—'} |`), '',
    ...(value.events.length ? [`## ${tr('События и уведомления')}`, '', ...value.events.map((event) => `- **${event.name}** — ${event.when}; ${tr('кому')}: ${event.to}; ${tr('канал')}: ${channels[event.channel]}`), ''] : []),
    ...(value.integrations.length ? [`## ${tr('Интеграции')}`, '', ...value.integrations.map((item) => `- **${item.service}**: ${item.call}. ${tr('Если не отвечает')}: ${item.onError}`), ''] : []),
  ].join('\n');
}

export function contractsChanges(before: Contracts, after: Contracts): string[] {
  const lines: string[] = [];
  const id = (operation: ContractOperation) => `${operation.method} ${operation.path}`;
  const old = new Map(before.operations.map((operation) => [id(operation), operation]));
  for (const operation of after.operations) {
    const was = old.get(id(operation));
    if (!was) lines.push(tr('Новая операция {0}', [id(operation)]));
    else if (JSON.stringify(was.roles) !== JSON.stringify(operation.roles)) lines.push(tr('Изменены права у {0}', [id(operation)]));
    else if (JSON.stringify(was.errors) !== JSON.stringify(operation.errors)) lines.push(tr('Изменены ошибки у {0}', [id(operation)]));
    old.delete(id(operation));
  }
  for (const operation of old.values()) lines.push(tr('Убрана операция {0}', [id(operation)]));
  if (JSON.stringify(before.modules) !== JSON.stringify(after.modules)) lines.push(tr('Изменены модули'));
  if (JSON.stringify(before.events) !== JSON.stringify(after.events)) lines.push(tr('Изменены события'));
  if (JSON.stringify(before.integrations) !== JSON.stringify(after.integrations)) lines.push(tr('Изменены интеграции'));
  return lines;
}
