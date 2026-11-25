// Architecture an owner or a specialist can edit (builder-docs PRODUCT_LIFECYCLE.md §4.6), for web applications. The plan's
// base is still computed from accepted stages; on top of it sit the design decisions people make: the data schema with
// types, required and unique fields and relations; components picked from a catalog — so nothing that cannot exist can be
// drawn; decisions with the options considered (ADR); threats with what stops them; environments. Every list is checked
// against the ТЗ: its data is in the schema, its services are components, its non-functional requirements have decisions,
// money and personal data have threats.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import type { BusinessProcess, ProcessEntity } from './process.js';
import type { AppFeatures } from './webapp.js';
import { QUALITY_KEYS, type QualityKey } from './spec-extras.js';

export const ARCHITECTURE_VERSION = '1.0.0';
export const ARCH_LIMITS = { entities: 16, fields: 20, relations: 30, options: 12, components: 16, decisions: 16, threats: 20, text: 400, name: 60 };

export const FIELD_TYPES = ['text', 'long_text', 'number', 'money', 'date', 'datetime', 'bool', 'status', 'email', 'phone', 'file', 'ref'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const RELATION_KINDS = ['one_one', 'one_many', 'many_many'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface SchemaField { key: string; name: string; type: FieldType; required: boolean; unique: boolean; ref: string | null; options: string[] }
export interface SchemaEntity { key: string; name: string; plain: string; fields: SchemaField[] }
/** from → to: one_many means one «from» has many «to» (each «to» keeps a link); many_many gets a link table of its own. */
export interface SchemaRelation { key: string; from: string; to: string; kind: RelationKind; label: string }
export interface DataSchema { entities: SchemaEntity[]; relations: SchemaRelation[] }

/** The parts an application can be made of. Picked, not typed: a component that is not here cannot be drawn. */
export const COMPONENT_CATALOG = {
  web_client: { title: 'Веб-приложение', plain: 'Экраны для каждой роли — работают в браузере на телефоне и компьютере.', category: 'core' },
  server_api: { title: 'Сервер приложения (API)', plain: 'Проверяет вход и права, сохраняет и выдаёт данные.', category: 'core' },
  database: { title: 'База данных', plain: 'Хранит записи по схеме данных.', category: 'core' },
  auth: { title: 'Вход и роли', plain: 'Регистрация, вход, восстановление пароля; каждый видит только своё.', category: 'core' },
  admin_panel: { title: 'Панель управления', plain: 'Экраны владельца и сотрудников для работы с записями.', category: 'core' },
  file_storage: { title: 'Хранилище файлов', plain: 'Фото, документы и вложения — отдельно от базы данных.', category: 'data' },
  search: { title: 'Поиск', plain: 'Быстрый поиск по каталогу или записям.', category: 'data' },
  cache: { title: 'Кэш', plain: 'Ускоряет частые запросы.', category: 'data' },
  queue: { title: 'Очередь задач', plain: 'Делает долгую работу в фоне: рассылки, отчёты, обработку файлов.', category: 'background' },
  scheduler: { title: 'Задачи по расписанию', plain: 'Напоминания и отчёты в нужное время.', category: 'background' },
  email: { title: 'Почта', plain: 'Письма пользователям: подтверждения, уведомления.', category: 'service' },
  sms: { title: 'SMS', plain: 'Короткие сообщения на телефон.', category: 'service' },
  messenger: { title: 'Мессенджер или бот', plain: 'Уведомления и ответы в Telegram или WhatsApp.', category: 'service' },
  push: { title: 'Push-уведомления', plain: 'Сообщения на телефон от приложения.', category: 'service' },
  payments: { title: 'Оплата', plain: 'Приём денег через платёжный сервис; деньги идут напрямую вам.', category: 'service' },
  analytics: { title: 'Аналитика', plain: 'Посещения, действия и цели продукта.', category: 'service' },
  external_api: { title: 'Внешний сервис', plain: 'Связь с другой системой по её API: учёт, склад, CRM.', category: 'service' },
} as const;
export type ComponentKey = keyof typeof COMPONENT_CATALOG;
const COMPONENT_KEYS = Object.keys(COMPONENT_CATALOG) as ComponentKey[];

export interface DesignComponent { key: string; kind: ComponentKey; name: string; note: string }
export interface DesignDecision { key: string; title: string; options: string[]; chosen: string; why: string; consequences: string; quality: QualityKey | null }
export const THREAT_ASSETS = ['money', 'personal_data', 'access', 'availability', 'content'] as const;
export const THREAT_ACTORS = ['dishonest_client', 'former_employee', 'outsider', 'staff_mistake'] as const;
export interface DesignThreat { key: string; asset: (typeof THREAT_ASSETS)[number]; actor: (typeof THREAT_ACTORS)[number]; how: string; mitigation: string }
export interface DesignEnvironment { key: 'test' | 'prod'; where: string; notes: string }
export interface ArchitectureDesign { schema: DataSchema; components: DesignComponent[]; decisions: DesignDecision[]; threats: DesignThreat[]; environments: DesignEnvironment[] }

export const fieldTypeLabels = (): Record<FieldType, string> => ({
  text: tr('текст'), long_text: tr('длинный текст'), number: tr('число'), money: tr('деньги'), date: tr('дата'), datetime: tr('дата и время'), bool: tr('да / нет'),
  status: tr('статус из списка'), email: tr('почта'), phone: tr('телефон'), file: tr('файл'), ref: tr('ссылка на запись'),
});
export const assetLabels = (): Record<DesignThreat['asset'], string> => ({ money: tr('деньги'), personal_data: tr('личные данные'), access: tr('доступ'), availability: tr('работа сервиса'), content: tr('содержимое') });
export const actorLabels = (): Record<DesignThreat['actor'], string> => ({ dishonest_client: tr('недобросовестный клиент'), former_employee: tr('бывший сотрудник'), outsider: tr('посторонний'), staff_mistake: tr('ошибка сотрудника') });

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
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => ((options as readonly unknown[]).includes(value) ? value as T : fallback);
function keyer(prefix: string) {
  const used = new Set<string>();
  return (value: unknown, index: number) => {
    let key = typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value) ? value : `${prefix}${index + 1}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    return key;
  };
}

export function normalizeDesign(raw: unknown): ArchitectureDesign {
  const value = isRecord(raw) ? raw : {};
  const schemaRaw = isRecord(value.schema) ? value.schema : {};
  const entityKey = keyer('e');
  const entities = list(schemaRaw.entities, 'schema.entities', ARCH_LIMITS.entities).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:schema.entities.${index}`);
    const fieldKey = keyer('f');
    const fields = list(item.fields, `schema.entities.${index}.fields`, ARCH_LIMITS.fields).map((field, position) => {
      if (!isRecord(field)) throw new ArtifactValidationError(`FIELD_INVALID:schema.entities.${index}.fields.${position}`);
      const type = oneOf(field.type, FIELD_TYPES, 'text');
      return {
        key: field.key, name: text(field.name, `schema.entities.${index}.fields.${position}.name`, ARCH_LIMITS.name), type,
        required: field.required === true, unique: field.unique === true, ref: type === 'ref' && typeof field.ref === 'string' ? field.ref : null,
        options: type === 'status' ? list(field.options, `schema.entities.${index}.fields.${position}.options`, ARCH_LIMITS.options).map((option, n) => text(option, `options.${n}`, 40)).filter(Boolean) : [],
      };
    }).filter((field) => field.name).map((field, position) => ({ ...field, key: fieldKey(field.key, position) }));
    return { key: item.key, name: text(item.name, `schema.entities.${index}.name`, ARCH_LIMITS.name), plain: text(item.plain, `schema.entities.${index}.plain`, ARCH_LIMITS.text), fields };
  }).filter((entity) => entity.name).map((entity, index) => ({ ...entity, key: entityKey(entity.key, index) }));
  const known = new Set(entities.map((entity) => entity.key));
  // A link to a record that is gone stops being a link: it reads as plain text until someone points it somewhere.
  for (const entity of entities) for (const field of entity.fields) if (field.type === 'ref' && (!field.ref || !known.has(field.ref))) { field.type = 'text'; field.ref = null; }
  const relationKey = keyer('r');
  const seen = new Set<string>();
  const relations = list(schemaRaw.relations, 'schema.relations', ARCH_LIMITS.relations).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:schema.relations.${index}`);
    return { key: item.key, from: typeof item.from === 'string' ? item.from : '', to: typeof item.to === 'string' ? item.to : '', kind: oneOf(item.kind, RELATION_KINDS, 'one_many'), label: text(item.label, `schema.relations.${index}.label`, ARCH_LIMITS.name) };
  }).filter((relation) => known.has(relation.from) && known.has(relation.to) && !seen.has(`${relation.from}:${relation.to}`) && seen.add(`${relation.from}:${relation.to}`))
    .map((relation, index) => ({ ...relation, key: relationKey(relation.key, index) }));

  const componentKey = keyer('c');
  const components = list(value.components, 'components', ARCH_LIMITS.components).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:components.${index}`);
    if (!(COMPONENT_KEYS as unknown[]).includes(item.kind)) return null;
    return { key: item.key, kind: item.kind as ComponentKey, name: text(item.name, `components.${index}.name`, ARCH_LIMITS.name), note: text(item.note, `components.${index}.note`, ARCH_LIMITS.text) };
  }).filter((item): item is NonNullable<typeof item> => item !== null).map((item, index) => ({ ...item, key: componentKey(item.key, index) }));

  const decisionKey = keyer('d');
  const decisions = list(value.decisions, 'decisions', ARCH_LIMITS.decisions).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:decisions.${index}`);
    return {
      key: item.key, title: text(item.title, `decisions.${index}.title`, 120), chosen: text(item.chosen, `decisions.${index}.chosen`, 200),
      options: list(item.options, `decisions.${index}.options`, 6).map((option, n) => text(option, `decisions.${index}.options.${n}`, 120)).filter(Boolean),
      why: text(item.why, `decisions.${index}.why`, ARCH_LIMITS.text), consequences: text(item.consequences, `decisions.${index}.consequences`, ARCH_LIMITS.text),
      quality: (QUALITY_KEYS as readonly unknown[]).includes(item.quality) ? item.quality as QualityKey : null,
    };
  }).filter((item) => item.title).map((item, index) => ({ ...item, key: decisionKey(item.key, index) }));

  const threatKey = keyer('t');
  const threats = list(value.threats, 'threats', ARCH_LIMITS.threats).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:threats.${index}`);
    return { key: item.key, asset: oneOf(item.asset, THREAT_ASSETS, 'personal_data'), actor: oneOf(item.actor, THREAT_ACTORS, 'outsider'), how: text(item.how, `threats.${index}.how`, ARCH_LIMITS.text), mitigation: text(item.mitigation, `threats.${index}.mitigation`, ARCH_LIMITS.text) };
  }).filter((item) => item.how).map((item, index) => ({ ...item, key: threatKey(item.key, index) }));

  const environments = (['test', 'prod'] as const).map((key) => {
    const found = list(value.environments, 'environments', 4).find((item) => isRecord(item) && item.key === key) as Record<string, unknown> | undefined;
    return { key, where: text(found?.where, `environments.${key}.where`, 200), notes: text(found?.notes, `environments.${key}.notes`, ARCH_LIMITS.text) };
  });
  return { schema: { entities, relations }, components, decisions, threats, environments };
}

/** The schema as stored plus the link tables many-to-many relations need: they are made, not drawn by hand. */
export function expandedSchema(schema: DataSchema): Array<SchemaEntity & { junction: boolean; links: Array<{ to: string; kind: 'one' | 'many'; label: string }> }> {
  const byKey = new Map(schema.entities.map((entity) => [entity.key, entity]));
  const out = schema.entities.map((entity) => ({ ...entity, junction: false, links: [] as Array<{ to: string; kind: 'one' | 'many'; label: string }> }));
  const find = (key: string) => out.find((entity) => entity.key === key)!;
  for (const relation of schema.relations) {
    if (relation.kind === 'many_many') {
      const a = byKey.get(relation.from)!;
      const b = byKey.get(relation.to)!;
      const key = `${relation.from}_${relation.to}`.slice(0, 32);
      out.push({ key, name: `${a.name} ↔ ${b.name}`, plain: tr('Связка: какие «{0}» относятся к каким «{1}».', [a.name, b.name]), junction: true,
        fields: [
          { key: 'a', name: a.name, type: 'ref', required: true, unique: false, ref: a.key, options: [] },
          { key: 'b', name: b.name, type: 'ref', required: true, unique: false, ref: b.key, options: [] },
        ], links: [{ to: a.key, kind: 'one', label: relation.label }, { to: b.key, kind: 'one', label: relation.label }] });
    } else {
      // The «many» side (or the second of one-to-one) keeps the link to the other.
      find(relation.to).links.push({ to: relation.from, kind: 'one', label: relation.label });
      if (relation.kind === 'one_many') find(relation.from).links.push({ to: relation.to, kind: 'many', label: relation.label });
    }
  }
  return out;
}

/** A service name that means taking money. */
const PAYMENT_NAME = /оплат|pay|kaspi|эквайр|stripe|cloudpayments/i;

const FIELD_TYPE_OF: Record<string, FieldType> = { datetime: 'datetime', date: 'date', money: 'money', number: 'number', phone: 'phone', email: 'email', boolean: 'bool', status: 'status', file: 'file', address: 'text', text: 'text' };

/** The first design without AI: schema from the process and the ТЗ, components from what they need, threats for what is at stake. */
export function templateDesign(input: { process: BusinessProcess | null; features: AppFeatures; entities: ProcessEntity[]; kindOf: (name: string) => string }): ArchitectureDesign {
  const { process, features, entities } = input;
  const schemaEntities = entities.map((entity, index) => ({
    key: entity.key, name: entity.name, plain: '',
    fields: entity.fields.map((name, position) => {
      const type = FIELD_TYPE_OF[input.kindOf(name)] ?? 'text';
      return { key: `f${position + 1}`, name, type, required: position === 0, unique: type === 'email' && entity.key === 'user', ref: null, options: type === 'status' ? [tr('новая'), tr('в работе'), tr('готово'), tr('отменена')] : [] };
    }),
    _index: index,
  })).map(({ _index: _unused, ...entity }) => entity);
  const relations: SchemaRelation[] = [];
  for (const entity of entities) for (const link of entity.links) {
    // «A has many B» → one A to many B; «A has one B» → A keeps a link to B: one B to many A.
    relations.push(link.kind === 'many' ? { key: `r${relations.length + 1}`, from: entity.key, to: link.to, kind: 'one_many', label: link.label } : { key: `r${relations.length + 1}`, from: link.to, to: entity.key, kind: 'one_many', label: link.label });
  }
  const steps = (process?.scenarios ?? []).flatMap((scenario) => scenario.steps.map((step) => step.capability));
  const component = (kind: ComponentKey, name = '', note = ''): DesignComponent => ({ key: kind, kind, name: name || tr(COMPONENT_CATALOG[kind].title), note });
  const components: DesignComponent[] = [component('web_client'), component('server_api'), component('database'), component('auth')];
  if (features.roles.length > 1) components.push(component('admin_panel'));
  if (steps.some((capability) => capability === 'remind_client')) components.push(component('scheduler'));
  if (steps.some((capability) => capability.startsWith('notify') || capability === 'remind_client')) components.push(component('email'));
  for (const service of features.services ?? []) {
    const kind: ComponentKey = PAYMENT_NAME.test(service.name) ? 'payments' : /sms|смс/i.test(service.name) ? 'sms' : /telegram|whatsapp|бот|мессендж/i.test(service.name) ? 'messenger' : /почт|mail/i.test(service.name) ? 'email' : /аналит|метрик|analytics/i.test(service.name) ? 'analytics' : 'external_api';
    if (!components.some((item) => item.kind === kind && item.name === service.name)) components.push({ key: `svc_${components.length}`, kind, name: service.name, note: service.purpose });
  }
  if (steps.includes('pay_online') && !components.some((item) => item.kind === 'payments')) components.push(component('payments'));
  const quality = features.quality ?? {};
  const decisions: DesignDecision[] = [];
  if (quality.dataLocation) decisions.push({ key: 'd_location', title: tr('Где хранить данные'), options: [tr('Облако в нужной стране'), tr('Свой сервер')], chosen: '', why: tr('Требование ТЗ: {0}', [quality.dataLocation]), consequences: '', quality: 'dataLocation' });
  if (quality.backups) decisions.push({ key: 'd_backups', title: tr('Резервные копии'), options: [tr('Автоматические копии базы у хостинга'), tr('Своя выгрузка по расписанию')], chosen: '', why: tr('Требование ТЗ: {0}', [quality.backups]), consequences: '', quality: 'backups' });
  const threats: DesignThreat[] = [];
  const add = (asset: DesignThreat['asset'], actor: DesignThreat['actor'], how: string, mitigation: string) => threats.push({ key: `t${threats.length + 1}`, asset, actor, how, mitigation });
  if (features.sensitivity !== 'normal') {
    add('personal_data', 'outsider', tr('Подбирает адреса записей (/bookings/124, /125…) и видит чужие данные.'), tr('Сервер проверяет, что запись принадлежит тому, кто спрашивает; номера записей не идут по порядку.'));
    add('personal_data', 'dishonest_client', tr('Меняет в запросе роль или чужой номер и пытается открыть то, что ему не положено.'), tr('Права проверяются на сервере по матрице «кто что может», а не по тому, что прислал браузер.'));
  }
  if (features.roles.length > 1) add('access', 'former_employee', tr('Уволенный сотрудник продолжает заходить и выгружать клиентов.'), tr('Отключение доступа сразу сбрасывает все его сессии; действия сотрудников записываются в журнал.'));
  add('availability', 'outsider', tr('Заваливает формы и вход запросами — сервис тормозит, приходит спам.'), tr('Ограничение частоты запросов на вход и формы; проверка от роботов.'));
  if (features.sensitivity === 'payments' || components.some((item) => item.kind === 'payments')) {
    add('money', 'outsider', tr('Присылает поддельное «оплачено», и заказ проходит без денег.'), tr('Статус оплаты меняет только подтверждение платёжного сервиса с проверкой подписи.'));
    add('money', 'dishonest_client', tr('Оплачивает, получает услугу и оспаривает платёж.'), tr('Чек и история заказа сохраняются; правила возврата видны до оплаты.'));
  }
  return normalizeDesign({ schema: { entities: schemaEntities, relations }, components, decisions, threats, environments: [{ key: 'test', where: '', notes: '' }, { key: 'prod', where: '', notes: '' }] });
}

export interface ArchitectureIssue { code: string; severity: 'important' | 'minor'; target: string; message: string; fix: string }

/** What the architecture owes the ТЗ (PRODUCT_LIFECYCLE §4.6 «Требования к результату»). */
export function designIssues(design: ArchitectureDesign, features: AppFeatures | null): ArchitectureIssue[] {
  const issues: ArchitectureIssue[] = [];
  const entities = new Set(design.schema.entities.map((entity) => entity.key));
  for (const key of new Set((features?.features ?? []).flatMap((feature) => feature.data ?? []))) {
    if (!entities.has(key)) issues.push({ code: 'ARCH_ENTITY_MISSING', severity: 'important', target: 'schema', message: tr('Данные «{0}» есть в ТЗ, но их нет в схеме данных.', [key]), fix: tr('Добавьте запись в схему или уберите эти данные из функций ТЗ.') });
  }
  const kinds = new Set(design.components.map((item) => item.kind));
  if (design.schema.entities.length && !(kinds.has('database') && kinds.has('server_api'))) issues.push({ code: 'ARCH_CORE_MISSING', severity: 'important', target: 'components', message: tr('Есть данные, но нет сервера приложения или базы данных — их негде хранить и обрабатывать.'), fix: tr('Добавьте «Сервер приложения» и «Базу данных».') });
  const names = design.components.map((item) => item.name.toLowerCase());
  for (const service of features?.services ?? []) {
    if (!names.includes(service.name.toLowerCase())) issues.push({ code: 'ARCH_SERVICE_MISSING', severity: 'important', target: 'components', message: tr('Интеграция «{0}» есть в ТЗ, но не стала компонентом архитектуры.', [service.name]), fix: tr('Добавьте компонент с тем же названием: оплата, почта, мессенджер или внешний сервис.') });
  }
  for (const key of QUALITY_KEYS) {
    if (!features?.quality?.[key] || design.decisions.some((decision) => decision.quality === key && decision.chosen)) continue;
    issues.push({ code: 'ARCH_QUALITY_NO_DECISION', severity: 'minor', target: 'decisions', message: tr('Требование «{0}» из ТЗ без решения: не видно, как его выполнить.', [features.quality[key]]), fix: tr('Добавьте решение: что выбрали, из каких вариантов и почему.') });
  }
  const assets = new Set(design.threats.map((threat) => threat.asset));
  if (features && features.sensitivity !== 'normal' && !assets.has('personal_data')) issues.push({ code: 'ARCH_THREATS_PERSONAL', severity: 'important', target: 'threats', message: tr('Продукт хранит личные данные, но угроз для них не описано.'), fix: tr('Опишите, кто может получить чужие данные и что этому мешает.') });
  // Money is at stake when the ТЗ says so, a payment service is in its integrations, or the design has payments.
  const paysInSpec = (features?.services ?? []).some((service) => PAYMENT_NAME.test(service.name));
  if ((features?.sensitivity === 'payments' || paysInSpec || kinds.has('payments')) && !assets.has('money')) issues.push({ code: 'ARCH_THREATS_MONEY', severity: 'important', target: 'threats', message: tr('В продукте есть деньги, но угроз для них не описано.'), fix: tr('Опишите, как могут обмануть с оплатой и что этому мешает.') });
  for (const threat of design.threats) if (!threat.mitigation) issues.push({ code: 'ARCH_THREAT_NO_MITIGATION', severity: 'important', target: threat.key, message: tr('У угрозы «{0}» нет меры против неё.', [threat.how]), fix: tr('Напишите, что этому мешает: проверка на сервере, журнал, ограничение.') });
  for (const decision of design.decisions) if (!decision.chosen) issues.push({ code: 'ARCH_DECISION_OPEN', severity: 'minor', target: decision.key, message: tr('Решение «{0}» не принято.', [decision.title]), fix: tr('Выберите вариант и запишите почему.') });
  return issues;
}

export function designMarkdown(design: ArchitectureDesign): string {
  const types = fieldTypeLabels();
  const entityName = (key: string) => design.schema.entities.find((entity) => entity.key === key)?.name ?? key;
  const kindText: Record<RelationKind, string> = { one_one: '1 — 1', one_many: '1 — N', many_many: 'N — N' };
  const lines: string[] = [`## ${tr('Схема данных')}`, ''];
  for (const entity of expandedSchema(design.schema)) {
    lines.push(`### ${entity.name}${entity.junction ? ` (${tr('связка')})` : ''}`, '', `| ${tr('Поле')} | ${tr('Тип')} | ${tr('Обязательное')} | ${tr('Уникальное')} |`, '|---|---|---|---|');
    for (const field of entity.fields) lines.push(`| ${field.name} | ${field.type === 'ref' ? `${types.ref} → ${entityName(field.ref ?? '')}` : field.type === 'status' && field.options.length ? `${types.status}: ${field.options.join(', ')}` : types[field.type]} | ${field.required ? '✓' : ''} | ${field.unique ? '✓' : ''} |`);
    lines.push('');
  }
  if (design.schema.relations.length) lines.push(`**${tr('Связи')}**`, '', ...design.schema.relations.map((relation) => `- ${entityName(relation.from)} ${kindText[relation.kind]} ${entityName(relation.to)}${relation.label ? ` — ${relation.label}` : ''}`), '');
  lines.push(`## ${tr('Компоненты')}`, '', ...design.components.map((item) => `- **${item.name}** (${tr(COMPONENT_CATALOG[item.kind].title)})${item.note ? ` — ${item.note}` : ''}`), '');
  if (design.decisions.length) {
    lines.push(`## ${tr('Решения')}`, '');
    for (const decision of design.decisions) lines.push(`### ${decision.title}`, '', `- ${tr('Варианты')}: ${decision.options.join('; ') || '—'}`, `- ${tr('Выбрано')}: ${decision.chosen || tr('не решено')}`, ...(decision.why ? [`- ${tr('Почему')}: ${decision.why}`] : []), ...(decision.consequences ? [`- ${tr('Что это меняет')}: ${decision.consequences}`] : []), '');
  }
  if (design.threats.length) {
    const assets = assetLabels();
    const actors = actorLabels();
    lines.push(`## ${tr('Угрозы и меры')}`, '', `| ${tr('Что под угрозой')} | ${tr('Кто')} | ${tr('Как')} | ${tr('Что мешает')} |`, '|---|---|---|---|',
      ...design.threats.map((threat) => `| ${assets[threat.asset]} | ${actors[threat.actor]} | ${threat.how} | ${threat.mitigation || '—'} |`), '');
  }
  const envs = design.environments.filter((item) => item.where || item.notes);
  if (envs.length) lines.push(`## ${tr('Окружения')}`, '', ...envs.map((item) => `- **${item.key === 'test' ? tr('Тестовое') : tr('Рабочее')}**: ${item.where}${item.notes ? ` — ${item.notes}` : ''}`), '');
  return lines.join('\n');
}
