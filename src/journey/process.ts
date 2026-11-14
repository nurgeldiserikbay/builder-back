// «Бизнес-процесс»: who takes part, how the main scenarios go step by step, the business rules and the information the
// business keeps. Plain language for the owner; each step carries a capability so the architecture can say honestly
// which steps the built product covers and which need a developer or stay manual.
import { tr } from '../i18n/i18n.js';
import type { Brief } from './artifacts.js';
import { ArtifactValidationError } from './artifacts.js';

export const ACTOR_KINDS = ['client', 'business', 'staff', 'system', 'external'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** What a step does, in terms the platform can match against what it builds. */
export const CAPABILITIES = {
  view_info: 'Посмотреть информацию на сайте',
  contact: 'Связаться: звонок, мессенджер или письмо',
  request_form: 'Оставить заявку через форму',
  choose_slot: 'Выбрать услугу, мастера и время',
  book: 'Записаться',
  cancel_booking: 'Отменить запись',
  notify_owner: 'Уведомить владельца',
  notify_master: 'Уведомить мастера',
  remind_client: 'Напомнить клиенту',
  mark_visit: 'Отметить, пришёл ли клиент',
  manage_schedule: 'Изменить расписание',
  choose_products: 'Выбрать товары в корзину',
  order: 'Оформить заказ',
  cancel_order: 'Отменить заказ',
  manage_orders: 'Подтвердить или выполнить заказ',
  pay_online: 'Оплатить онлайн',
  account: 'Личный кабинет клиента',
  offline: 'Делается вне сайта, вручную',
  other: 'Другое',
} as const;
export type Capability = keyof typeof CAPABILITIES;
const capabilityKeys = Object.keys(CAPABILITIES) as Capability[];

export interface ProcessActor { key: string; name: string; kind: ActorKind }
export interface ProcessStep { key: string; actor: string; action: string; capability: Capability }
export interface ProcessScenario { key: string; title: string; goal: string; steps: ProcessStep[] }
export interface ProcessLink { to: string; kind: 'one' | 'many'; label: string }
export interface ProcessEntity { key: string; name: string; fields: string[]; links: ProcessLink[] }
export interface BusinessProcess { actors: ProcessActor[]; scenarios: ProcessScenario[]; rules: string[]; data: ProcessEntity[] }

export const PROCESS_LIMITS = { actors: 6, scenarios: 6, steps: 12, rules: 12, entities: 8, fields: 10, links: 6 };

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
/** Keys are stable identifiers used by steps and links; missing or bad ones are replaced. */
function keyOf(value: unknown, prefix: string, index: number, used: Set<string>): string {
  let key = typeof value === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(value) ? value : `${prefix}${index + 1}`;
  while (used.has(key)) key = `${key}_`;
  used.add(key);
  return key;
}

export function normalizeProcess(raw: unknown): BusinessProcess {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const actorKeys = new Set<string>();
  const actors = list(raw.actors, 'actors', PROCESS_LIMITS.actors).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:actors');
    const kind = ACTOR_KINDS.includes(item.kind as ActorKind) ? item.kind as ActorKind : 'client';
    return { key: keyOf(item.key, 'a', index, actorKeys), name: text(item.name, 'actors', 40, false), kind };
  });
  const entityKeys = new Set<string>();
  const rawEntities = list(raw.data, 'data', PROCESS_LIMITS.entities).map((item) => { if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:data'); return item; });
  const entityKeyList = rawEntities.map((item, index) => keyOf(item.key, 'e', index, entityKeys));
  const data = rawEntities.map((item, index) => ({
    key: entityKeyList[index]!,
    name: text(item.name, 'data', 40, false),
    fields: list(item.fields, 'data', PROCESS_LIMITS.fields).map((field) => text(field, 'data', 60, false)).filter(Boolean),
    links: list(item.links, 'data', PROCESS_LIMITS.links).flatMap((link) => {
      if (!isRecord(link) || typeof link.to !== 'string' || !entityKeys.has(link.to) || link.to === entityKeyList[index]) return [];
      return [{ to: link.to, kind: link.kind === 'one' ? 'one' as const : 'many' as const, label: text(link.label, 'data', 60, false) }];
    }),
  }));
  const scenarioKeys = new Set<string>();
  const scenarios = list(raw.scenarios, 'scenarios', PROCESS_LIMITS.scenarios).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:scenarios');
    const stepKeys = new Set<string>();
    return {
      key: keyOf(item.key, 's', index, scenarioKeys),
      title: text(item.title, 'scenarios', 80, false),
      goal: text(item.goal, 'scenarios', 200, false),
      steps: list(item.steps, 'scenarios', PROCESS_LIMITS.steps).map((step, stepIndex) => {
        if (!isRecord(step)) throw new ArtifactValidationError('FIELD_INVALID:scenarios');
        // A step must belong to someone in the list of participants.
        const actor = typeof step.actor === 'string' && actorKeys.has(step.actor) ? step.actor : actors[0]?.key;
        if (!actor) throw new ArtifactValidationError('FIELD_REQUIRED:actors');
        const capability = capabilityKeys.includes(step.capability as Capability) ? step.capability as Capability : 'other';
        return { key: keyOf(step.key, 'p', stepIndex, stepKeys), actor, action: text(step.action, 'scenarios', 160, false), capability };
      }),
    };
  });
  const rules = list(raw.rules, 'rules', PROCESS_LIMITS.rules).map((rule) => text(rule, 'rules', 200, false)).filter(Boolean);
  return { actors, scenarios, rules, data };
}

export interface ProcessIssue { key: string; message: string }

export function processIssues(process: BusinessProcess): ProcessIssue[] {
  const issues: ProcessIssue[] = [];
  if (!process.actors.some((actor) => actor.kind === 'client')) issues.push({ key: 'actors', message: tr('Добавьте клиента — того, для кого работает сайт.') });
  if (process.actors.length < 2) issues.push({ key: 'actors', message: tr('Добавьте хотя бы двух участников: клиента и того, кто ему отвечает.') });
  if (!process.scenarios.length) issues.push({ key: 'scenarios', message: tr('Опишите хотя бы один сценарий.') });
  for (const scenario of process.scenarios) {
    if (scenario.steps.length < 2) issues.push({ key: 'scenarios', message: tr('В сценарии «{0}» нужно хотя бы два шага.', [scenario.title]) });
  }
  if (process.actors.some((actor) => !actor.name)) issues.push({ key: 'actors', message: tr('У каждого участника должно быть имя.') });
  if (process.scenarios.some((scenario) => !scenario.title)) issues.push({ key: 'scenarios', message: tr('У каждого сценария должно быть название.') });
  if (process.scenarios.some((scenario) => scenario.steps.some((step) => !step.action))) issues.push({ key: 'scenarios', message: tr('Опишите каждый шаг: что происходит.') });
  if (process.data.some((entity) => !entity.name)) issues.push({ key: 'data', message: tr('У каждой записи в схеме данных должно быть название.') });
  if (!process.data.length) issues.push({ key: 'data', message: tr('Укажите, какую информацию вы храните — хотя бы одну.') });
  return issues;
}

/** The business keeps clients' contacts in every template, so the draft says how it treats them (the review asks for it). */
export const consentRule = () => tr('Контакты клиентов храним с их согласия только для ответа и записи и удаляем по их просьбе.');

/** A starting draft from the goal, without AI: the typical process of this kind of project. */
export function templateProcess(projectType: string, brief: Brief | null): BusinessProcess {
  const name = brief?.businessName || tr("Вы");
  const client: ProcessActor = { key: 'client', name: tr("Клиент"), kind: 'client' };
  const owner: ProcessActor = { key: 'owner', name: name.length <= 40 ? name : tr("Владелец"), kind: 'business' };
  const site: ProcessActor = { key: 'site', name: tr("Сайт"), kind: 'system' };
  if (projectType === 'store') {
    return {
      actors: [client, site, owner],
      scenarios: [
        { key: 'order', title: tr('Заказ'), goal: tr('Клиент выбирает товары и оформляет заказ без звонка и регистрации.'), steps: [
          { key: 'p1', actor: 'client', action: tr('Смотрит каталог и кладёт товары в корзину'), capability: 'choose_products' },
          { key: 'p2', actor: 'client', action: tr('Выбирает способ получения и оплаты, оставляет имя и телефон'), capability: 'order' },
          { key: 'p3', actor: 'site', action: tr('Сообщает владельцу о новом заказе'), capability: 'notify_owner' },
          { key: 'p4', actor: 'owner', action: tr('Звонит клиенту и подтверждает заказ'), capability: 'manage_orders' },
          { key: 'p5', actor: 'owner', action: tr('Собирает и передаёт заказ, получает оплату'), capability: 'offline' },
          { key: 'p6', actor: 'owner', action: tr('Отмечает заказ выполненным'), capability: 'manage_orders' },
        ] },
        { key: 'cancel', title: tr('Отмена'), goal: tr('Клиент отменяет заказ, пока его не подтвердили.'), steps: [
          { key: 'p1', actor: 'client', action: tr('Открывает свой заказ по ссылке и отменяет'), capability: 'cancel_order' },
          { key: 'p2', actor: 'site', action: tr('Сообщает владельцу об отмене'), capability: 'notify_owner' },
        ] },
      ],
      rules: [tr('Цены и наличие — по принятому каталогу.'), tr('Заказ можно отменить по ссылке, пока магазин его не подтвердил.'), consentRule()],
      data: [
        { key: 'client', name: tr('Клиент'), fields: [tr('Имя'), tr('Телефон'), tr('Адрес доставки')], links: [{ to: 'order', kind: 'many', label: tr('делает заказы') }] },
        { key: 'order', name: tr('Заказ'), fields: [tr('Номер'), tr('Товары и количество'), tr('Способ получения'), tr('Оплата'), tr('Статус')], links: [{ to: 'product', kind: 'many', label: tr('товары') }] },
        { key: 'product', name: tr('Товар'), fields: [tr('Название'), tr('Цена'), tr('В наличии')], links: [] },
      ],
    };
  }
  if (projectType === 'booking') {
    const master: ProcessActor = { key: 'master', name: tr("Мастер"), kind: 'staff' };
    return {
      actors: [client, site, master, owner],
      scenarios: [
        { key: 'book', title: tr("Запись"), goal: tr("Клиент записывается на свободное время без звонка."), steps: [
          { key: 'p1', actor: 'client', action: tr("Открывает сайт и выбирает услугу"), capability: 'view_info' },
          { key: 'p2', actor: 'client', action: tr("Выбирает мастера, день и свободное время"), capability: 'choose_slot' },
          { key: 'p3', actor: 'client', action: tr("Оставляет имя и телефон и подтверждает запись"), capability: 'book' },
          { key: 'p4', actor: 'site', action: tr("Сообщает владельцу и мастеру о новой записи"), capability: 'notify_master' },
          { key: 'p5', actor: 'site', action: tr("Напоминает клиенту о визите"), capability: 'remind_client' },
          { key: 'p6', actor: 'master', action: tr("Принимает клиента и отмечает, что он пришёл"), capability: 'mark_visit' },
        ] },
        { key: 'cancel', title: tr("Отмена"), goal: tr("Клиент сам освобождает время, если планы изменились."), steps: [
          { key: 'p1', actor: 'client', action: tr("Открывает свою запись по ссылке и отменяет"), capability: 'cancel_booking' },
          { key: 'p2', actor: 'site', action: tr("Освобождает время и сообщает владельцу"), capability: 'notify_owner' },
        ] },
        { key: 'schedule', title: tr("Изменение расписания"), goal: tr("Владелец меняет услуги, мастеров и часы работы."), steps: [
          { key: 'p1', actor: 'owner', action: tr("Меняет расписание и принимает новую версию"), capability: 'manage_schedule' },
          { key: 'p2', actor: 'site', action: tr("Показывает клиентам новое свободное время"), capability: 'view_info' },
        ] },
      ],
      rules: [tr("Одно время у мастера может занять только один клиент."), tr("Клиент может отменить запись не позже чем за несколько часов до визита."), consentRule()],
      data: [
        { key: 'client', name: tr("Клиент"), fields: [tr("Имя"), tr("Телефон"), tr("Почта для напоминания")], links: [{ to: 'booking', kind: 'many', label: tr("записывается") }] },
        { key: 'booking', name: tr("Запись"), fields: [tr("Услуга"), tr("Мастер"), tr("Время"), tr("Комментарий"), tr("Статус")], links: [{ to: 'service', kind: 'one', label: tr("на услугу") }, { to: 'master', kind: 'one', label: tr("к мастеру") }] },
        { key: 'service', name: tr("Услуга"), fields: [tr("Название"), tr("Длительность"), tr("Цена")], links: [] },
        { key: 'master', name: tr("Мастер"), fields: [tr("Имя"), tr("Рабочие дни и часы")], links: [{ to: 'service', kind: 'many', label: tr("делает") }] },
      ],
    };
  }
  const action = brief?.mainAction ?? 'message';
  const contactStep: ProcessStep = action === 'form'
    ? { key: 'p2', actor: 'client', action: tr("Оставляет заявку через форму на сайте"), capability: 'request_form' }
    : action === 'visit'
      ? { key: 'p2', actor: 'client', action: tr("Находит адрес и часы работы и приходит"), capability: 'offline' }
      : { key: 'p2', actor: 'client', action: action === 'call' ? tr("Звонит по кнопке на сайте") : action === 'email' ? tr("Пишет письмо по кнопке на сайте") : tr("Пишет в мессенджер по кнопке на сайте"), capability: 'contact' };
  const steps: ProcessStep[] = [
    { key: 'p1', actor: 'client', action: projectType === 'company_site' ? tr("Открывает сайт и смотрит услуги и цены") : tr("Открывает сайт и читает, чем вы занимаетесь"), capability: 'view_info' },
    contactStep,
    ...(action === 'form' ? [{ key: 'p3', actor: 'site', action: tr("Передаёт заявку владельцу в Telegram или на почту"), capability: 'notify_owner' as const }] : []),
    { key: 'p4', actor: 'owner', action: tr("Отвечает клиенту и договаривается о деталях"), capability: 'offline' },
  ];
  return {
    actors: action === 'form' ? [client, site, owner] : [client, owner],
    scenarios: [{ key: 'contact', title: tr("Обращение клиента"), goal: tr("Посетитель понимает, чем вы полезны, и связывается с вами."), steps }],
    rules: action === 'form' ? [tr("На заявку отвечаем в течение рабочего дня."), consentRule()] : [consentRule()],
    data: action === 'form'
      ? [{ key: 'lead', name: tr("Заявка"), fields: [tr("Имя"), tr("Контакт"), tr("Сообщение"), tr("Когда пришла")], links: [] }]
      : [{ key: 'contact', name: tr("Контакты для связи"), fields: [tr("Телефон или мессенджер"), tr("Адрес"), tr("Часы работы")], links: [] }],
  };
}

/** Lines for the change notice of a new process version. */
export function processChanges(before: BusinessProcess, after: BusinessProcess): string[] {
  const lines: string[] = [];
  const names = (items: Array<{ key: string; name?: string; title?: string }>) => new Map(items.map((item) => [item.key, item.name ?? item.title ?? item.key]));
  for (const [label, a, b] of [['Участник', names(before.actors), names(after.actors)], ['Сценарий', names(before.scenarios), names(after.scenarios)], ['Данные', names(before.data), names(after.data)]] as const) {
    for (const [key, value] of b) if (!a.has(key)) lines.push(tr('{0}: добавлено «{1}»', [tr(label), value]));
    for (const [key, value] of a) if (!b.has(key)) lines.push(tr('{0}: убрано «{1}»', [tr(label), value]));
  }
  for (const scenario of after.scenarios) {
    const previous = before.scenarios.find((item) => item.key === scenario.key);
    if (previous && JSON.stringify(previous.steps) !== JSON.stringify(scenario.steps)) lines.push(tr('Изменены шаги сценария «{0}»', [scenario.title]));
  }
  if (JSON.stringify(before.rules) !== JSON.stringify(after.rules)) lines.push(tr('Изменены правила'));
  return lines;
}
