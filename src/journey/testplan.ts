// «План проверки» of a web application (builder-docs PRODUCT_LIFECYCLE.md §4.10): test cases written before the code. Each
// case is an instruction for a person (who, from what state, which steps, what must and must not happen) and a description
// for an automatic test. Drafted from the ТЗ (stories, access matrix, quality), the process situations, the architecture's
// threats and the contracts; each case is linked to the task of the implementation plan it proves, so a task is «готова»
// only when its cases pass.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import type { ArchitectureDesign, DesignThreat } from './architecture.js';
import type { Contracts } from './contracts.js';
import type { BusinessProcess } from './process.js';
import type { Roadmap } from './roadmap.js';
import { SITUATIONS } from './situations.js';
import type { AccessAction } from './spec-extras.js';
import type { AppFeatures } from './webapp.js';

export const TESTPLAN_VERSION = '1.0.0';
export const TESTPLAN_LIMITS = { cases: 150, steps: 8, text: 400, skipped: 10 };
export const CASE_CLASSES = ['normal', 'mistakes', 'edge', 'dishonest', 'rights', 'security', 'data_law', 'failures', 'load', 'devices'] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];
export const CASE_METHODS = ['auto', 'ai_browser', 'human'] as const;
export type CaseMethod = (typeof CASE_METHODS)[number];

export interface TestCase {
  key: string; title: string; class: CaseClass;
  /** Role key of who acts; null for an outsider or the system. */
  actor: string | null; honest: boolean;
  given: string; steps: string[]; expected: string;
  /** What must not happen: the part a dishonest user is after. */
  mustNot: string;
  /** What it proves: feature:<key>, rule:<text key>, threat:<key>, access:<role>.<data>, quality:<key>, operation:<key>, integration:<key>. */
  links: string[];
  /** The plan task it proves; its «готова» waits for this case. */
  task: string | null;
  method: CaseMethod; blocking: boolean; source: 'platform' | 'owner' | 'ai';
  /** The case in the owner's words: «Мы проверим, что …». */
  plain: string;
}
export interface SkippedClass { class: CaseClass; why: string }
export interface TestPlan { cases: TestCase[]; skipped: SkippedClass[]; notes: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return trimmed;
}
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const LINK = /^(feature|rule|threat|access|quality|operation|integration|situation):[a-z0-9_.]{1,64}$/;

export function normalizeTestPlan(raw: unknown): TestPlan {
  const value = isRecord(raw) ? raw : {};
  const cases = Array.isArray(value.cases) ? value.cases : [];
  if (cases.length > TESTPLAN_LIMITS.cases) throw new ArtifactValidationError('FIELD_TOO_MANY:cases');
  const used = new Set<string>();
  const out = cases.map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:cases.${index}`);
    let key = typeof item.key === 'string' && KEY.test(item.key) ? item.key : `c${index + 1}`;
    let n = index + 1;
    while (used.has(key)) key = `c${++n}`;
    used.add(key);
    const steps = (Array.isArray(item.steps) ? item.steps : []).slice(0, TESTPLAN_LIMITS.steps).map((step, s) => text(step, `cases.${index}.steps.${s}`, 300)).filter(Boolean);
    return {
      key, title: text(item.title, `cases.${index}.title`, 160), class: (CASE_CLASSES as readonly unknown[]).includes(item.class) ? item.class as CaseClass : 'normal',
      actor: typeof item.actor === 'string' && KEY.test(item.actor) ? item.actor : null, honest: item.honest !== false,
      given: text(item.given, `cases.${index}.given`, TESTPLAN_LIMITS.text), steps, expected: text(item.expected, `cases.${index}.expected`, TESTPLAN_LIMITS.text),
      mustNot: text(item.mustNot, `cases.${index}.mustNot`, TESTPLAN_LIMITS.text),
      links: Array.isArray(item.links) ? [...new Set(item.links.filter((link): link is string => typeof link === 'string' && LINK.test(link)))].slice(0, 6) : [],
      task: typeof item.task === 'string' && KEY.test(item.task) ? item.task : null,
      method: (CASE_METHODS as readonly unknown[]).includes(item.method) ? item.method as CaseMethod : 'auto', blocking: item.blocking === true,
      source: (item.source === 'owner' || item.source === 'ai' ? item.source : 'platform') as TestCase['source'],
      plain: text(item.plain, `cases.${index}.plain`, 300),
    };
  }).filter((item) => item.title);
  const skipped = (Array.isArray(value.skipped) ? value.skipped : []).slice(0, TESTPLAN_LIMITS.skipped).filter(isRecord)
    .map((item, index) => ({ class: item.class as CaseClass, why: text(item.why, `skipped.${index}.why`, 300) }))
    .filter((item) => (CASE_CLASSES as readonly string[]).includes(item.class) && item.why);
  return { cases: out, skipped: [...new Map(skipped.map((item) => [item.class, item])).values()], notes: text(value.notes, 'notes', 1000) };
}

const actionWord = (): Record<AccessAction, string> => ({ view: tr('посмотреть'), create: tr('создать'), edit: tr('изменить'), delete: tr('удалить') });

export interface TestPlanInputs { features: AppFeatures; contracts: Contracts | null; design: ArchitectureDesign | null; roadmap: Roadmap | null; process: BusinessProcess | null }

/** The first plan without AI: cases of every class from the sources, linked to the plan tasks. */
export function templateTestPlan(input: TestPlanInputs): TestPlan {
  const { features, contracts, design, roadmap, process } = input;
  const cases: TestCase[] = [];
  const roleName = (key: string) => features.roles.find((role) => role.key === key)?.name ?? key;
  const entityName = (key: string) => design?.schema.entities.find((entity) => entity.key === key)?.name ?? process?.data.find((entity) => entity.key === key)?.name ?? key;
  const tasks = roadmap?.modules.flatMap((module) => module.tasks.map((task) => ({ ...task, module }))) ?? [];
  const taskForFeature = (feature: string) => tasks.find((task) => task.feature === feature)?.key ?? null;
  const moduleOf = (entity: string) => contracts?.modules.find((module) => module.owns.includes(entity))?.key ?? null;
  const taskForEntity = (entity: string) => {
    const module = moduleOf(entity);
    const planModule = roadmap?.modules.find((item) => item.contractModule === module);
    return planModule?.tasks.find((task) => !task.feature)?.key ?? planModule?.tasks[0]?.key ?? null;
  };
  const setupTask = roadmap?.modules.find((module) => module.key === 'setup')?.tasks[0]?.key ?? null;
  const add = (item: Omit<TestCase, 'key' | 'source' | 'mustNot'> & { mustNot?: string }) => cases.push({ key: `c${cases.length + 1}`, source: 'platform', mustNot: '', ...item });
  const firstVersion = features.features.filter((feature) => feature.priority === 'must');
  const sensitive = features.sensitivity !== 'normal';

  // Normal path: the ТЗ's «Дано / Когда / Тогда», or the «готово, когда» items of a feature without them.
  for (const feature of firstVersion) {
    const actor = feature.roles[0] ?? null;
    const own = (feature.cases ?? []).length ? feature.cases : feature.acceptance.slice(0, 2).map((line, index) => ({ key: `a${index}`, given: tr('Пользователь вошёл с ролью «{0}»', [roleName(actor ?? '')]), when: tr('Выполняет: {0}', [feature.title]), then: line }));
    for (const item of own) add({ title: tr('«{0}»: {1}', [feature.title, item.then]).slice(0, 160), class: 'normal', actor, honest: true, given: item.given, steps: [item.when], expected: item.then,
      links: [`feature:${feature.key}`], task: taskForFeature(feature.key), method: 'auto', blocking: true, plain: tr('Мы проверим, что {0}', [lower(item.then)]).slice(0, 300) });
    // Mistakes: a wrong value and a double tap, for every feature that creates something.
    const creates = contracts?.operations.filter((operation) => operation.action === 'create' && operation.entity && (feature.data ?? []).includes(operation.entity)) ?? [];
    for (const operation of creates.slice(0, 1)) {
      add({ title: tr('«{0}»: обязательное поле пустое или неверное', [feature.title]).slice(0, 160), class: 'mistakes', actor, honest: true, given: tr('Пользователь заполняет форму «{0}»', [entityName(operation.entity!)]),
        steps: [tr('Оставляет обязательное поле пустым или вводит текст вместо числа или даты'), tr('Нажимает «Сохранить»')], expected: tr('Запись не создана; рядом с полем понятно, что исправить; введённое не пропало'), mustNot: tr('Сохранена неполная запись'),
        links: [`feature:${feature.key}`, `operation:${operation.key}`], task: taskForFeature(feature.key), method: 'auto', blocking: true, plain: tr('Мы проверим, что при ошибке в форме человек видит, что исправить, и ничего не теряет').slice(0, 300) });
      add({ title: tr('«{0}»: двойное нажатие', [feature.title]).slice(0, 160), class: 'mistakes', actor, honest: true, given: tr('Форма заполнена верно; интернет медленный'), steps: [tr('Дважды быстро нажимает «Сохранить»')],
        expected: tr('Создана одна запись'), mustNot: tr('Две одинаковые записи'), links: [`feature:${feature.key}`, `operation:${operation.key}`], task: taskForFeature(feature.key), method: 'auto', blocking: false, plain: tr('Мы проверим, что двойное нажатие не создаёт дубль') });
    }
  }
  // Rights: for every record, a role the matrix does not allow an action tries it anyway; «own» means not another's.
  const access = features.access ?? [];
  for (const entity of [...new Set(access.map((row) => row.data))]) {
    for (const action of ['view', 'create', 'edit', 'delete'] as AccessAction[]) {
      const allowed = access.filter((row) => row.data === entity && row.actions.includes(action)).map((row) => row.role);
      if (!allowed.length) continue;
      const denied = features.roles.filter((role) => !allowed.includes(role.key));
      for (const role of denied.slice(0, 1)) add({ title: tr('«{0}» не может {1}: {2}', [role.name, actionWord()[action], entityName(entity)]).slice(0, 160), class: 'rights', actor: role.key, honest: false,
        given: tr('Пользователь вошёл с ролью «{0}»; запись «{1}» существует', [role.name, entityName(entity)]), steps: [tr('Открывает адрес или отправляет запрос, чтобы {0} запись напрямую, минуя экран', [actionWord()[action]])],
        expected: tr('Отказ: «нет прав» (403); ничего не изменилось'), mustNot: tr('Действие выполнено или данные показаны'), links: [`access:${role.key}.${entity}`], task: taskForEntity(entity), method: 'auto', blocking: true,
        plain: tr('Мы проверим, что «{0}» не может {1} «{2}», даже если знает адрес', [role.name, actionWord()[action], entityName(entity)]).slice(0, 300) });
    }
    for (const row of access.filter((item) => item.data === entity && item.scope === 'own').slice(0, 1)) add({ title: tr('«{0}» видит только свои записи «{1}»', [roleName(row.role), entityName(entity)]).slice(0, 160), class: 'rights', actor: row.role, honest: false,
      given: tr('Есть две записи «{0}»: своя и чужая', [entityName(entity)]), steps: [tr('Открывает список'), tr('Меняет номер записи в адресе на номер чужой')],
      expected: tr('В списке только своя; чужая по адресу — «не найдено» (404), так же как несуществующая'), mustNot: tr('Чужая запись показана или по ответу понятно, что она существует'), links: [`access:${row.role}.${entity}`], task: taskForEntity(entity), method: 'auto', blocking: true,
      plain: tr('Мы проверим, что «{0}» не увидит чужие «{1}», даже подбирая номера', [roleName(row.role), entityName(entity)]).slice(0, 300) });
  }
  // Dishonest users and security: from the architecture's threats, then the usual attacks on any app with a sign-in.
  for (const threat of design?.threats ?? []) add(threatCase(threat, setupTask, features));
  add({ title: tr('Подбор пароля'), class: 'security', actor: null, honest: false, given: tr('Аккаунт существует'), steps: [tr('Отправляет 20 попыток входа с разными паролями за минуту')], expected: tr('После нескольких неудач — «слишком много попыток» (429); ответ не говорит, есть ли такая почта'),
    mustNot: tr('Неограниченные попытки'), links: ['operation:login'], task: taskOfOperation('login', contracts, roadmap) ?? setupTask, method: 'auto', blocking: true, plain: tr('Мы проверим, что пароль нельзя подобрать перебором') });
  add({ title: tr('Код в полях формы (XSS)'), class: 'security', actor: null, honest: false, given: tr('Любая форма с текстовым полем'), steps: [tr('Вводит в поле <script>alert(1)</script> и сохраняет'), tr('Открывает экран, где это поле показано')],
    expected: tr('Текст показан как текст'), mustNot: tr('Скрипт выполнился'), links: [], task: setupTask, method: 'auto', blocking: true, plain: tr('Мы проверим, что введённый в поле код не выполнится у других людей') });
  add({ title: tr('Запрос с чужого сайта (CSRF)'), class: 'security', actor: null, honest: false, given: tr('Пользователь вошёл; открыта страница другого сайта'), steps: [tr('Чужая страница отправляет запрос на изменение данных от имени пользователя')],
    expected: tr('Запрос отклонён'), mustNot: tr('Данные изменились'), links: [], task: setupTask, method: 'auto', blocking: true, plain: tr('Мы проверим, что чужой сайт не может действовать от имени пользователя') });
  // Data and law: personal data can be deleted, consent is kept, errors do not leak it.
  if (sensitive) {
    add({ title: tr('Удаление личных данных по просьбе'), class: 'data_law', actor: features.roles.find((role) => role.key === 'owner' || /владел|админ/i.test(role.name))?.key ?? features.roles[0]?.key ?? null, honest: true,
      given: tr('Клиент попросил удалить свои данные'), steps: [tr('Ответственный удаляет данные клиента')], expected: tr('Личные данные удалены или обезличены во всех записях, выгрузках и копиях по правилам хранения'),
      mustNot: tr('Данные остались в другой таблице или в уведомлениях'), links: ['quality:retention'], task: setupTask, method: 'human', blocking: true, plain: tr('Мы проверим, что по просьбе клиента его данные удаляются везде') });
    add({ title: tr('Личные данные не попадают в ошибки и журналы'), class: 'data_law', actor: null, honest: true, given: tr('Сервер получает неверный запрос с телефоном и почтой'), steps: [tr('Смотрит ответ с ошибкой и журнал сервера')],
      expected: tr('В ответе нет чужих данных; в журнале телефон и почта скрыты'), links: [], task: setupTask, method: 'auto', blocking: true, plain: tr('Мы проверим, что личные данные не утекают в сообщения об ошибках и журналы') });
  }
  // Failures: every outside service from the contracts behaves as written when it does not answer.
  for (const integration of contracts?.integrations ?? []) add({ title: tr('«{0}» не отвечает', [integration.service]).slice(0, 160), class: 'failures', actor: null, honest: true,
    given: tr('Сервис «{0}» недоступен', [integration.service]), steps: [tr('Пользователь делает действие, которое вызывает сервис')], expected: integration.onError || tr('Как записано в контрактах'), mustNot: tr('Действие потеряно молча'),
    links: [`integration:${integration.key}`], task: tasks.find((task) => task.title.includes(integration.service))?.key ?? null, method: 'auto', blocking: true, plain: tr('Мы проверим, что сбой «{0}» не теряет действие пользователя', [integration.service]).slice(0, 300) });
  add({ title: tr('Восстановление из резервной копии'), class: 'failures', actor: null, honest: true, given: tr('Есть резервная копия базы'), steps: [tr('Восстанавливает базу из копии в тестовом окружении')], expected: tr('Приложение работает, данные на момент копии на месте'),
    links: ['quality:backups'], task: setupTask, method: 'human', blocking: false, plain: tr('Мы проверим, что данные можно восстановить из копии') });
  // Edge cases: the owner's answers to «Вы это учли?» are rules the app must follow.
  for (const situation of (process?.situations ?? []).filter((item) => item.answer && item.answer !== 'later').slice(0, 12)) {
    const definition = SITUATIONS.find((item) => item.key === situation.key);
    const rule = situation.rule || definition?.options.find((option) => option.value === situation.answer)?.rule || situation.custom || '';
    if (!rule) continue;
    add({ title: tr('Правило: {0}', [rule]).slice(0, 160), class: 'edge', actor: null, honest: true, given: tr('Ситуация: {0}', [tr(definition?.question ?? situation.key)]).slice(0, 400), steps: [tr('Воспроизводит ситуацию в тестовой версии')],
      expected: rule.slice(0, 400), links: [`situation:${situation.key}`], task: null, method: 'ai_browser', blocking: false, plain: tr('Мы проверим правило: {0}', [lower(rule)]).slice(0, 300) });
  }
  // Load, speed, devices, accessibility: from the ТЗ's quality requirements, with one phone check always.
  const quality = (features.quality ?? {}) as Record<string, string>;
  if (quality.users || quality.speed) add({ title: tr('Нагрузка и скорость'), class: 'load', actor: null, honest: true, given: [quality.users, quality.speed].filter(Boolean).join('; ').slice(0, 400),
    steps: [tr('Нагрузочный тест: столько пользователей одновременно, сколько записано в ТЗ')], expected: tr('Экраны открываются не дольше, чем записано в ТЗ; ошибок нет'), links: ['quality:users', 'quality:speed'].filter((link) => quality[link.split(':')[1]!]), task: setupTask, method: 'auto', blocking: false, plain: tr('Мы проверим, что приложение выдерживает нагрузку из ТЗ') });
  add({ title: tr('Главный сценарий на телефоне'), class: 'devices', actor: firstVersion[0]?.roles[0] ?? null, honest: true, given: quality.devices || tr('Телефон с экраном шириной 360 px, медленный интернет'),
    steps: [tr('Проходит главный сценарий от входа до результата')], expected: tr('Всё видно и нажимается без горизонтальной прокрутки; текст читается без увеличения'), links: quality.devices ? ['quality:devices'] : [], task: null, method: 'ai_browser', blocking: true, plain: tr('Мы проверим, что главным сценарием удобно пользоваться с телефона') });
  add({ title: tr('Только клавиатура и экранный диктор'), class: 'devices', actor: null, honest: true, given: quality.accessibility || tr('Человек не пользуется мышью'), steps: [tr('Проходит главный сценарий клавишей Tab и диктором')],
    expected: tr('До каждой кнопки и поля можно дойти; у полей есть подписи; фокус виден'), links: quality.accessibility ? ['quality:accessibility'] : [], task: null, method: 'human', blocking: false, plain: tr('Мы проверим, что приложением можно пользоваться без мыши и с экранным диктором') });
  return normalizeTestPlan({ cases: cases.slice(0, TESTPLAN_LIMITS.cases), skipped: [], notes: '' });
}

const lower = (value: string) => (value ? value[0]!.toLowerCase() + value.slice(1) : value).replace(/[.。]$/, '');
function taskOfOperation(operation: string, contracts: Contracts | null, roadmap: Roadmap | null): string | null {
  const module = contracts?.operations.find((item) => item.key === operation)?.module;
  return roadmap?.modules.find((item) => item.contractModule === module)?.tasks[0]?.key ?? null;
}
function threatCase(threat: DesignThreat, task: string | null, features: AppFeatures): Omit<TestCase, 'key' | 'source'> {
  const honest = threat.actor === 'staff_mistake';
  return {
    title: tr('Угроза: {0}', [threat.how]).slice(0, 160), class: threat.actor === 'dishonest_client' || threat.actor === 'former_employee' ? 'dishonest' : 'security',
    actor: threat.actor === 'dishonest_client' ? features.roles.find((role) => /клиент|client/i.test(`${role.key} ${role.name}`))?.key ?? null : null, honest,
    given: tr('Угроза из архитектуры'), steps: [threat.how], expected: threat.mitigation || tr('Мера из архитектуры работает'), mustNot: threat.how,
    links: [`threat:${threat.key}`], task, method: 'auto', blocking: threat.asset === 'money' || threat.asset === 'personal_data' || threat.asset === 'access',
    plain: tr('Мы проверим, что не получится: {0}', [lower(threat.how)]).slice(0, 300),
  };
}

export interface TestPlanIssue { code: string; severity: 'blocking' | 'important' | 'minor'; target: string; message: string; fix: string }
export const classLabels = (): Record<CaseClass, string> => ({
  normal: tr('Нормальный путь'), mistakes: tr('Ошибки и невнимательность'), edge: tr('Крайние случаи'), dishonest: tr('Недобросовестный пользователь'), rights: tr('Права и роли'),
  security: tr('Безопасность'), data_law: tr('Данные и закон'), failures: tr('Сбои и восстановление'), load: tr('Нагрузка и скорость'), devices: tr('Устройства и доступность'),
});

export function testPlanIssues(value: TestPlan, features: AppFeatures | null, design: ArchitectureDesign | null): TestPlanIssue[] {
  const issues: TestPlanIssue[] = [];
  const labels = classLabels();
  const has = (feature: string, kind: CaseClass) => value.cases.some((item) => item.class === kind && item.links.includes(`feature:${feature}`));
  const entityCase = (feature: { data?: string[] }, kind: CaseClass) => value.cases.some((item) => item.class === kind && (feature.data ?? []).some((entity) => item.links.some((link) => link.startsWith('access:') && link.endsWith(`.${entity}`))));
  for (const feature of (features?.features ?? []).filter((item) => item.priority === 'must')) {
    if (!has(feature.key, 'normal')) issues.push({ code: 'TESTPLAN_NO_NORMAL', severity: 'important', target: 'cases', message: tr('У функции «{0}» нет кейса нормального пути.', [feature.title]), fix: tr('Добавьте кейс: кто, что делает и что должно получиться.') });
    if (!has(feature.key, 'mistakes') && (feature.data ?? []).some((entity) => entity !== 'user')) issues.push({ code: 'TESTPLAN_NO_MISTAKES', severity: 'minor', target: 'cases', message: tr('У функции «{0}» нет кейса на ошибку пользователя.', [feature.title]), fix: tr('Например: пустое поле, неверный формат, двойное нажатие.') });
    if (!entityCase(feature, 'rights') && (feature.data ?? []).some((entity) => entity !== 'user') && (features?.roles.length ?? 0) > 1) issues.push({ code: 'TESTPLAN_NO_RIGHTS', severity: 'important', target: 'cases', message: tr('У функции «{0}» нет кейса «кому нельзя».', [feature.title]), fix: tr('Добавьте кейс: роль без прав пытается сделать это напрямую по адресу.') });
  }
  if (features && features.sensitivity !== 'normal') {
    for (const kind of ['dishonest', 'security'] as CaseClass[]) if (!value.cases.some((item) => item.class === kind) && !value.skipped.some((item) => item.class === kind)) issues.push({ code: 'TESTPLAN_SENSITIVE_UNCOVERED', severity: 'important', target: kind, message: tr('Приложение хранит личные данные или деньги, а кейсов класса «{0}» нет.', [labels[kind]]), fix: tr('Добавьте кейсы или объясните, почему они не нужны.') });
  }
  for (const threat of design?.threats ?? []) if (!value.cases.some((item) => item.links.includes(`threat:${threat.key}`))) issues.push({ code: 'TESTPLAN_THREAT_UNCOVERED', severity: 'important', target: 'cases', message: tr('Угроза «{0}» не проверяется ни одним кейсом.', [threat.how.slice(0, 80)]), fix: tr('Добавьте кейс со ссылкой на эту угрозу.') });
  for (const item of value.cases) {
    if (!item.expected) issues.push({ code: 'TESTPLAN_NO_EXPECTED', severity: 'important', target: item.key, message: tr('У кейса «{0}» нет ожидаемого результата.', [item.title]), fix: tr('Напишите, что должно получиться и что не должно произойти.') });
    if (!item.steps.length) issues.push({ code: 'TESTPLAN_NO_STEPS', severity: 'minor', target: item.key, message: tr('У кейса «{0}» нет шагов.', [item.title]), fix: tr('Опишите, что делает человек, по шагам.') });
  }
  for (const kind of CASE_CLASSES) if (!value.cases.some((item) => item.class === kind) && !value.skipped.some((item) => item.class === kind)) issues.push({ code: 'TESTPLAN_CLASS_EMPTY', severity: 'minor', target: kind, message: tr('Нет кейсов класса «{0}».', [labels[kind]]), fix: tr('Добавьте кейс или напишите, почему этот класс не нужен.') });
  return issues;
}

export function testPlanMarkdown(value: TestPlan, features: AppFeatures | null): string {
  const labels = classLabels();
  const roleName = (key: string | null) => (key ? features?.roles.find((role) => role.key === key)?.name ?? key : tr('посторонний или система'));
  const methods: Record<CaseMethod, string> = { auto: tr('автотест'), ai_browser: tr('ИИ-агент в браузере'), human: tr('человек') };
  return [
    `# ${tr('План проверки')}`, '',
    `## ${tr('Что мы проверим — простыми словами')}`, '', ...value.cases.filter((item) => item.plain).map((item) => `- ${item.plain}`), '',
    ...CASE_CLASSES.flatMap((kind) => {
      const own = value.cases.filter((item) => item.class === kind);
      const skipped = value.skipped.find((item) => item.class === kind);
      if (!own.length) return skipped ? [`## ${labels[kind]}`, '', `${tr('Не нужен')}: ${skipped.why}`, ''] : [];
      return [`## ${labels[kind]}`, '', ...own.flatMap((item) => [
        `### ${item.key}. ${item.title}${item.blocking ? ` — ${tr('блокирует запуск')}` : ''}`, '',
        `- ${tr('Кто')}: ${roleName(item.actor)}${item.honest ? '' : ` (${tr('недобросовестный')})`}`,
        `- ${tr('Дано')}: ${item.given || '—'}`, `- ${tr('Когда')}:`, ...item.steps.map((step, index) => `  ${index + 1}. ${step}`),
        `- ${tr('Тогда')}: ${item.expected}`, ...(item.mustNot ? [`- ${tr('Не должно')}: ${item.mustNot}`] : []),
        `- ${tr('Как проверяется')}: ${methods[item.method]}${item.links.length ? ` · ${item.links.join(', ')}` : ''}${item.task ? ` · ${tr('задача')} ${item.task}` : ''}`, '',
      ])];
    }),
    tr('Автоматические проверки не заменяют аудит безопасности. Для продуктов с деньгами и личными данными мы рекомендуем специалиста по безопасности.'), '',
  ].join('\n');
}

export function testPlanChanges(before: TestPlan, after: TestPlan): string[] {
  const lines: string[] = [];
  for (const item of after.cases) {
    const was = before.cases.find((other) => other.key === item.key);
    if (!was) lines.push(tr('Новый кейс «{0}»', [item.title]));
    else if (JSON.stringify(was) !== JSON.stringify(item)) lines.push(tr('Изменён кейс «{0}»', [item.title]));
  }
  for (const item of before.cases) if (!after.cases.some((other) => other.key === item.key)) lines.push(tr('Убран кейс «{0}»', [item.title]));
  if (JSON.stringify(before.skipped) !== JSON.stringify(after.skipped)) lines.push(tr('Изменены ненужные классы'));
  return lines;
}

/** Cases the AI added are marked as its own; a case already in the plan keeps who wrote it, whatever the AI claims. */
export function markAiCases(base: TestPlan | null, next: TestPlan): TestPlan {
  const before = new Map((base?.cases ?? []).map((item) => [item.key, item.source]));
  return { ...next, cases: next.cases.map((item) => ({ ...item, source: before.get(item.key) ?? 'ai' })) };
}
