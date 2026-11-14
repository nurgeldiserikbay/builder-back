// Quality review of a stage result: deterministic rules for logic gaps and weak spots that a later stage would trip over.
// Completeness (artifacts.ts) says what is missing; the review says what does not fit together or is risky.
// A blocking finding stops acceptance until it is fixed or the owner explains in writing why the stage goes on anyway.
import { tr } from '../i18n/i18n.js';
import { keywords } from '../analysis/requirements-match.js';
import { sectionTypeLabels, type Brief, type ContentArtifact } from './artifacts.js';
import type { Catalog } from './products.js';
import type { Schedule } from './schedule.js';
import type { Sitemap } from './sitemap.js';
import type { TechPlan } from './techplan.js';
import type { BusinessProcess } from './process.js';
import type { AppFeatures, AppScreens } from './webapp.js';

export const REVIEW_RULES_VERSION = '1.1.0';
export const REVIEW_LIMITS = { reason: 1000, findings: 60, instruction: 1000 };

export type FindingSeverity = 'blocking' | 'important' | 'minor';
export type FindingCategory = 'logic' | 'security' | 'clarity';
export interface ReviewFinding {
  /** Stable while the problem stays the same: code plus the item it is about. */
  id: string;
  code: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** Key of the part of the result the finding is about (an actor, a scenario, a screen), or null for the whole result. */
  target: string | null;
  where: string;
  message: string;
  fix: string;
}
export interface StageReview { rulesVersion: string; score: number; findings: ReviewFinding[]; blocking: number }

/** Words that show a field or rule keeps or protects personal data. Stems, matched against the keyword stems of a text. */
const PERSONAL_FIELD = keywords('телефон phone email почта адрес address фамилия имя name иин паспорт passport дата рождения birthday');
const CONSENT_RULE = keywords('согласие согласен consent персональные personal конфиденциальность privacy удаление удалить delete хранение срок retention');
const PAYMENT_CONFIRM = keywords('подтверждение подтвердить confirm чек receipt возврат refund отмена cancel');

function overlaps(text: string, words: string[]): boolean {
  const own = new Set(keywords(text));
  return words.some((word) => own.has(word));
}

type Push = (finding: Omit<ReviewFinding, 'id'>) => void;

function briefReview(brief: Brief, push: Push) {
  if (brief.whatYouDo && brief.whatYouDo.trim().length < 25) push({
    code: 'GOAL_WHAT_TOO_SHORT', severity: 'important', category: 'clarity', target: 'whatYouDo', where: tr('Чем вы занимаетесь'),
    message: tr('Описание слишком короткое: из него не получится понятный первый экран.'),
    fix: tr('Напишите одно-два предложения: что вы делаете, для кого и чем отличаетесь.'),
  });
  if (brief.audience && brief.audience.trim().length < 15) push({
    code: 'GOAL_AUDIENCE_VAGUE', severity: 'minor', category: 'clarity', target: 'audience', where: tr('Кто ваши клиенты'),
    message: tr('Клиенты описаны слишком общо — тексты получатся для всех и ни для кого.'),
    fix: tr('Уточните, кто они и с какой задачей приходят.'),
  });
}

function processReview(process: BusinessProcess, push: Push) {
  const actorKeys = new Set(process.actors.map((actor) => actor.key));
  const entityKeys = new Set(process.data.map((entity) => entity.key));
  const steps = process.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({ scenario, step })));
  for (const { scenario, step } of steps) {
    if (!actorKeys.has(step.actor)) push({
      code: 'PROCESS_STEP_UNKNOWN_ACTOR', severity: 'blocking', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('Шаг «{0}» делает участник, которого нет в списке.', [step.action || '—']),
      fix: tr('Выберите для шага участника из списка или добавьте его.'),
    });
  }
  for (const actor of process.actors) {
    if (!steps.some(({ step }) => step.actor === actor.key)) push({
      code: 'PROCESS_ACTOR_IDLE', severity: 'important', category: 'logic', target: actor.key, where: tr('Участник «{0}»', [actor.name]),
      message: tr('Участник ни в одном сценарии ничего не делает.'),
      fix: tr('Добавьте его шаги в сценарий или уберите участника.'),
    });
  }
  for (const scenario of process.scenarios) {
    if (!scenario.goal.trim()) push({
      code: 'PROCESS_SCENARIO_NO_RESULT', severity: 'important', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('Не сказано, чем сценарий заканчивается — непонятно, когда он выполнен.'),
      fix: tr('Опишите результат: что получает клиент или бизнес в конце.'),
    });
    if (scenario.steps.length === 1) push({
      code: 'PROCESS_SCENARIO_ONE_STEP', severity: 'minor', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('В сценарии один шаг: обычно кто-то должен ответить или подтвердить.'),
      fix: tr('Добавьте, что происходит после первого шага.'),
    });
  }
  const names = new Map<string, number>();
  for (const entity of process.data) names.set(entity.name.trim().toLowerCase(), (names.get(entity.name.trim().toLowerCase()) ?? 0) + 1);
  for (const entity of process.data) {
    for (const link of entity.links) {
      if (!entityKeys.has(link.to)) push({
        code: 'PROCESS_LINK_UNKNOWN', severity: 'blocking', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
        message: tr('Связь ведёт к записи, которой нет в схеме данных.'),
        fix: tr('Удалите связь или добавьте недостающую запись.'),
      });
    }
    if (!entity.fields.length) push({
      code: 'PROCESS_ENTITY_NO_FIELDS', severity: 'important', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
      message: tr('У записи нет ни одного поля — непонятно, что о ней хранится.'),
      fix: tr('Перечислите, что нужно знать: например, имя, дату, статус.'),
    });
    const linked = entity.links.length > 0 || process.data.some((other) => other.links.some((link) => link.to === entity.key));
    if (process.data.length > 1 && !linked) push({
      code: 'PROCESS_ENTITY_ISOLATED', severity: 'minor', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
      message: tr('Запись ни с чем не связана — так бывает редко.'),
      fix: tr('Укажите, к чему она относится: например, заявка относится к клиенту.'),
    });
    if ((names.get(entity.name.trim().toLowerCase()) ?? 0) > 1) push({
      code: 'PROCESS_ENTITY_DUPLICATE', severity: 'important', category: 'clarity', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
      message: tr('Две записи называются одинаково — в разработке их перепутают.'),
      fix: tr('Объедините их или назовите по-разному.'),
    });
  }
  const personal = process.data.filter((entity) => entity.fields.some((field) => overlaps(field, PERSONAL_FIELD)));
  if (personal.length && !process.rules.some((rule) => overlaps(rule, CONSENT_RULE))) push({
    code: 'PROCESS_PERSONAL_DATA_NO_RULE', severity: 'blocking', category: 'security', target: 'rules', where: tr('Правила'),
    message: tr('Вы храните личные данные людей ({0}), но нет правила о согласии и сроке хранения.', [personal.map((entity) => entity.name).join(', ')]),
    fix: tr('Добавьте правило: клиент даёт согласие на обработку данных, сколько данные хранятся и как их удалить по просьбе.'),
  });
  const pays = steps.filter(({ step }) => step.capability === 'pay_online');
  if (pays.length && !steps.some(({ step }) => step.capability !== 'pay_online' && overlaps(step.action, PAYMENT_CONFIRM)) && !process.rules.some((rule) => overlaps(rule, PAYMENT_CONFIRM))) push({
    code: 'PROCESS_PAYMENT_NO_CONFIRM', severity: 'blocking', category: 'security', target: pays[0]!.scenario.key, where: tr('Сценарий «{0}»', [pays[0]!.scenario.title]),
    message: tr('Есть онлайн-оплата, но не описано подтверждение оплаты, чек и возврат.'),
    fix: tr('Добавьте шаг подтверждения оплаты и правило возврата денег.'),
  });
}

function featuresReview(value: AppFeatures, push: Push) {
  const roleKeys = new Set(value.roles.map((role) => role.key));
  for (const feature of value.features) {
    const unknown = feature.roles.filter((role) => !roleKeys.has(role));
    if (unknown.length) push({
      code: 'FEATURES_UNKNOWN_ROLE', severity: 'blocking', category: 'logic', target: feature.key, where: tr('Функция «{0}»', [feature.title]),
      message: tr('Функцией пользуется роль, которой нет в списке ролей.'),
      fix: tr('Выберите роли из списка или добавьте недостающую роль.'),
    });
    if (feature.priority === 'must' && feature.acceptance.length === 1 && feature.acceptance[0]!.trim().length < 15) push({
      code: 'FEATURES_ACCEPTANCE_VAGUE', severity: 'minor', category: 'clarity', target: feature.key, where: tr('Функция «{0}»', [feature.title]),
      message: tr('Критерий приёмки слишком короткий — по нему трудно проверить работу.'),
      fix: tr('Опишите проверку: кто, что делает и какой результат видит.'),
    });
  }
  for (const role of value.roles) {
    if (!value.features.some((feature) => feature.roles.includes(role.key))) push({
      code: 'FEATURES_ROLE_IDLE', severity: 'important', category: 'logic', target: role.key, where: tr('Роль «{0}»', [role.name]),
      message: tr('У роли нет ни одной функции — ей нечего делать в приложении.'),
      fix: tr('Добавьте функции для этой роли или уберите её.'),
    });
  }
  const allText = value.features.map((feature) => [feature.title, feature.description, ...feature.acceptance].join(' ')).join(' ');
  if ((value.sensitivity === 'personal' || value.sensitivity === 'health') && !overlaps(allText, CONSENT_RULE)) push({
    code: 'FEATURES_PERSONAL_NO_PRIVACY', severity: 'blocking', category: 'security', target: 'sensitivity', where: tr('Чувствительность данных'),
    message: tr('Приложение хранит личные данные, но нет функции согласия на обработку и удаления данных по просьбе.'),
    fix: tr('Добавьте обязательную функцию: согласие при регистрации и удаление аккаунта с данными.'),
  });
  if (value.sensitivity === 'payments' && !overlaps(allText, PAYMENT_CONFIRM)) push({
    code: 'FEATURES_PAYMENT_NO_CONFIRM', severity: 'blocking', category: 'security', target: 'sensitivity', where: tr('Чувствительность данных'),
    message: tr('Есть платежи, но нет функции подтверждения оплаты, чека и возврата.'),
    fix: tr('Добавьте функцию: подтверждение оплаты, чек и возврат денег.'),
  });
  if (value.roles.length > 1 && !value.features.some((feature) => feature.acceptance.some((line) => overlaps(line, keywords('роли роль права разрешено доступ role access permission'))))) push({
    code: 'FEATURES_NO_ACCESS_RULE', severity: 'important', category: 'security', target: 'features', where: tr('Функции'),
    message: tr('Ролей несколько, но нигде не сказано, что каждая видит только своё.'),
    fix: tr('Добавьте критерий приёмки: каждый видит только то, что разрешено его роли.'),
  });
}

function screensReview(value: AppScreens, features: AppFeatures | null, push: Push) {
  const byKey = new Map(value.screens.map((screen) => [screen.key, screen]));
  for (const screen of value.screens) {
    for (const link of screen.links) {
      const target = byKey.get(link);
      if (!target) push({
        code: 'SCREENS_LINK_UNKNOWN', severity: 'blocking', category: 'logic', target: screen.key, where: tr('Экран «{0}»', [screen.title]),
        message: tr('Переход ведёт на экран, которого нет.'),
        fix: tr('Удалите переход или добавьте недостающий экран.'),
      });
      else if (target.role !== screen.role) push({
        code: 'SCREENS_CROSS_ROLE_LINK', severity: 'important', category: 'security', target: screen.key, where: tr('Экран «{0}»', [screen.title]),
        message: tr('Отсюда можно перейти на экран другой роли («{0}»).', [target.title]),
        fix: tr('Уберите переход или сделайте отдельный экран для этой роли, чтобы никто не видел чужие данные.'),
      });
    }
    if (screen.blocks.some((block) => block.kind === 'form' && !block.fields.length)) push({
      code: 'SCREENS_FORM_NO_FIELDS', severity: 'important', category: 'logic', target: screen.key, where: tr('Экран «{0}»', [screen.title]),
      message: tr('На экране есть форма без полей — непонятно, что в ней заполнять.'),
      fix: tr('Перечислите поля формы.'),
    });
  }
  // Each role starts on its first screen; every other screen of the role must be reachable from it by links.
  const roles = [...new Set(value.screens.map((screen) => screen.role))];
  for (const role of roles) {
    const own = value.screens.filter((screen) => screen.role === role);
    const seen = new Set<string>([own[0]!.key]);
    const queue = [own[0]!.key];
    while (queue.length) for (const next of byKey.get(queue.shift()!)?.links ?? []) if (!seen.has(next) && byKey.get(next)?.role === role) { seen.add(next); queue.push(next); }
    for (const screen of own) if (!seen.has(screen.key)) push({
      code: 'SCREENS_UNREACHABLE', severity: 'important', category: 'logic', target: screen.key, where: tr('Экран «{0}»', [screen.title]),
      message: tr('На этот экран нельзя попасть со стартового экрана роли.'),
      fix: tr('Добавьте переход на него с другого экрана.'),
    });
  }
  if (features) {
    const known = new Set(features.features.map((feature) => feature.key));
    for (const screen of value.screens) if (screen.features.some((key) => !known.has(key))) push({
      code: 'SCREENS_UNKNOWN_FEATURE', severity: 'minor', category: 'logic', target: screen.key, where: tr('Экран «{0}»', [screen.title]),
      message: tr('Экран ссылается на функцию, которой нет в принятых функциях.'),
      fix: tr('Уберите лишнюю функцию с экрана или добавьте её на этапе «Функции».'),
    });
  }
}

function sitemapReview(map: Sitemap, push: Push) {
  const titles = new Map<string, number>();
  for (const page of map.pages) titles.set(page.title.trim().toLowerCase(), (titles.get(page.title.trim().toLowerCase()) ?? 0) + 1);
  for (const page of map.pages) {
    if (page.title && (titles.get(page.title.trim().toLowerCase()) ?? 0) > 1) push({
      code: 'SITEMAP_DUPLICATE_TITLE', severity: 'important', category: 'clarity', target: page.key, where: tr('Страница «{0}»', [page.title]),
      message: tr('Две страницы называются одинаково — в меню посетитель их не различит.'),
      fix: tr('Назовите страницы по-разному или объедините их.'),
    });
    if (!page.purpose.trim()) push({
      code: 'SITEMAP_NO_PURPOSE', severity: 'minor', category: 'clarity', target: page.key, where: tr('Страница «{0}»', [page.title]),
      message: tr('Не сказано, зачем посетителю эта страница — тексты для неё получатся случайными.'),
      fix: tr('Напишите в одной фразе, что посетитель здесь узнаёт или делает.'),
    });
  }
  const home = map.pages.find((page) => page.path === '/');
  if (home && !home.sections.includes('hero')) push({
    code: 'SITEMAP_HOME_NO_HERO', severity: 'important', category: 'logic', target: home.key, where: tr('Страница «{0}»', [home.title]),
    message: tr('Главная страница без первого экрана — посетитель не сразу поймёт, куда попал.'),
    fix: tr('Добавьте на главную блок «Первый экран».'),
  });
  if (!map.pages.some((page) => page.sections.includes('cta') || (page.sections.includes('contacts') && page.path === '/'))) push({
    code: 'SITEMAP_NO_CALL_TO_ACTION', severity: 'important', category: 'logic', target: 'pages', where: tr('Карта сайта'),
    message: tr('Ни на одной странице нет призыва к действию — посетитель дочитает и уйдёт.'),
    fix: tr('Добавьте блок «Призыв к действию» на главную или страницу услуг.'),
  });
}

function contentReview(content: ContentArtifact, push: Push) {
  for (const section of content.sections) {
    const name = section.title || sectionTypeLabels[section.type];
    if ((section.type === 'hero' || section.type === 'cta') && !section.buttonLabel?.trim()) push({
      code: 'CONTENT_NO_BUTTON', severity: 'important', category: 'logic', target: section.key, where: tr('Блок «{0}»', [name]),
      message: tr('В блоке нет кнопки — посетителю нечего нажать.'),
      fix: tr('Напишите текст кнопки главного действия: например, «Записаться».'),
    });
    if ((section.type === 'about' || section.type === 'hero') && section.text.trim().length < 20) push({
      code: 'CONTENT_TEXT_THIN', severity: 'minor', category: 'clarity', target: section.key, where: tr('Блок «{0}»', [name]),
      message: tr('Текст блока слишком короткий, чтобы что-то объяснить.'),
      fix: tr('Добавьте одно-два предложения: что вы делаете и чем это полезно.'),
    });
    if ((section.type === 'faq' || section.type === 'benefits' || section.type === 'steps') && section.items.length === 1) push({
      code: 'CONTENT_ONE_ITEM', severity: 'minor', category: 'clarity', target: section.key, where: tr('Блок «{0}»', [name]),
      message: tr('В блоке один пункт — список из одного выглядит недоделанным.'),
      fix: tr('Добавьте ещё пункты или замените блок обычным текстом.'),
    });
  }
  const seo = [content.seo, ...(content.pageSeo ?? [])];
  if (seo.some((item) => item.title.length > 60)) push({
    code: 'CONTENT_SEO_TITLE_LONG', severity: 'minor', category: 'clarity', target: 'seo', where: tr('Для поисковиков'),
    message: tr('Заголовок для поисковиков длиннее 60 символов — в выдаче он обрежется.'),
    fix: tr('Сократите заголовок до 60 символов: главное — в начале.'),
  });
  if (seo.some((item) => !item.description.trim())) push({
    code: 'CONTENT_SEO_NO_DESCRIPTION', severity: 'minor', category: 'clarity', target: 'seo', where: tr('Для поисковиков'),
    message: tr('Нет описания для поисковиков — в выдаче будет случайный кусок текста.'),
    fix: tr('Напишите описание в 1–2 предложения, до 160 символов.'),
  });
}

function scheduleReview(schedule: Schedule, push: Push) {
  const names = new Set(schedule.services.map((service) => service.name));
  for (const master of schedule.masters) {
    const unknown = master.services.filter((name) => !names.has(name));
    if (unknown.length) push({
      code: 'SCHEDULE_MASTER_UNKNOWN_SERVICE', severity: 'important', category: 'logic', target: master.key, where: tr('Мастер «{0}»', [master.name]),
      message: tr('У мастера отмечены услуги, которых нет в списке: {0}.', [unknown.join(', ')]),
      fix: tr('Выберите услуги из списка или добавьте их.'),
    });
  }
  const { rules } = schedule;
  if (rules.minNoticeHours >= rules.horizonDays * 24) push({
    code: 'SCHEDULE_NO_BOOKABLE_DAYS', severity: 'blocking', category: 'logic', target: 'rules', where: tr('Правила записи'),
    message: tr('Записаться заранее нужно минимум за {0} ч, а запись открыта только на {1} дн. — свободного времени не будет никогда.', [rules.minNoticeHours, rules.horizonDays]),
    fix: tr('Уменьшите «за сколько записываться» или откройте запись на больше дней.'),
  });
  if (rules.cancelHours > rules.horizonDays * 24) push({
    code: 'SCHEDULE_CANCEL_NEVER', severity: 'important', category: 'logic', target: 'rules', where: tr('Правила записи'),
    message: tr('Отменить запись можно только раньше, чем она вообще открывается, — клиент никогда не сможет отменить сам.'),
    fix: tr('Сделайте срок отмены короче, чем срок, на который открыта запись.'),
  });
  const shortest = Math.min(...schedule.services.map((service) => service.minutes));
  if (Number.isFinite(shortest) && rules.slotStep > shortest) push({
    code: 'SCHEDULE_STEP_TOO_LONG', severity: 'minor', category: 'logic', target: 'rules', where: tr('Правила записи'),
    message: tr('Шаг записи ({0} мин) длиннее самой короткой услуги ({1} мин) — между записями будут пустые окна.', [rules.slotStep, shortest]),
    fix: tr('Сделайте шаг записи не длиннее самой короткой услуги.'),
  });
}

function catalogReview(catalog: Catalog, push: Push) {
  const names = new Map<string, number>();
  for (const product of catalog.products) names.set(product.name.trim().toLowerCase(), (names.get(product.name.trim().toLowerCase()) ?? 0) + 1);
  for (const product of catalog.products) if (product.name && (names.get(product.name.trim().toLowerCase()) ?? 0) > 1) push({
    code: 'CATALOG_DUPLICATE_NAME', severity: 'important', category: 'clarity', target: product.key, where: tr('Товар «{0}»', [product.name]),
    message: tr('Два товара называются одинаково — покупатель и вы перепутаете заказы.'),
    fix: tr('Уточните названия: вес, вкус, размер.'),
  });
  if (catalog.payment.transfer && !catalog.payment.transferNote.trim()) push({
    code: 'CATALOG_TRANSFER_NO_NOTE', severity: 'important', category: 'logic', target: 'payment', where: tr('Оплата'),
    message: tr('Можно платить переводом, но не написано куда и как — клиент не сможет оплатить.'),
    fix: tr('Напишите, как перевести деньги: например, Kaspi по номеру телефона после подтверждения заказа.'),
  });
  const noPhoto = catalog.products.filter((product) => product.available && !product.imageId);
  if (noPhoto.length && noPhoto.length === catalog.products.filter((product) => product.available).length) push({
    code: 'CATALOG_NO_PHOTOS', severity: 'minor', category: 'clarity', target: 'products', where: tr('Товары'),
    message: tr('Ни у одного товара нет фото — в магазине без фото покупают реже.'),
    fix: tr('Добавьте фото хотя бы к главным товарам.'),
  });
  const cheapest = Math.min(...catalog.products.filter((product) => product.available && product.price > 0).map((product) => product.price));
  if (catalog.minOrder && Number.isFinite(cheapest) && catalog.minOrder > cheapest * 20) push({
    code: 'CATALOG_MIN_ORDER_HIGH', severity: 'minor', category: 'logic', target: 'minOrder', where: tr('Минимальный заказ'),
    message: tr('Минимальный заказ во много раз больше цены товаров — проверьте, нет ли лишнего нуля.'),
    fix: tr('Проверьте сумму минимального заказа.'),
  });
}

function techPlanReview(plan: TechPlan, push: Push) {
  const missing = (plan.coverage ?? []).filter((step) => step.status === 'not_built');
  if (missing.length) push({
    code: 'TECHPLAN_STEPS_NOT_BUILT', severity: 'important', category: 'logic', target: 'coverage', where: tr('Что покрывает сайт'),
    message: tr('Шагов процесса, которые сайт не сделает и которые не делаются вручную: {0} ({1}).', [missing.length, missing.slice(0, 3).map((step) => step.action).join('; ')]),
    fix: tr('Решите для каждого: делать вручную (поменяйте шаг на этапе «Бизнес-процесс») или заказать разработчику.'),
  });
  const keys = new Set(plan.dataModel.map((entity) => entity.key));
  for (const entity of plan.dataModel) if (entity.links.some((link) => !keys.has(link.to))) push({
    code: 'TECHPLAN_LINK_UNKNOWN', severity: 'blocking', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
    message: tr('Связь в схеме данных ведёт к таблице, которой нет.'),
    fix: tr('Исправьте связи на этапе «Бизнес-процесс» — архитектура соберётся заново.'),
  });
}

const WEIGHT: Record<FindingSeverity, number> = { blocking: 25, important: 10, minor: 3 };
const ORDER: Record<FindingSeverity, number> = { blocking: 0, important: 1, minor: 2 };

/** Review of one stage result. Types without rules yet get an empty review with the full score. */
export function reviewStage(type: string, content: unknown, context: { features?: AppFeatures | null } = {}): StageReview {
  const found: ReviewFinding[] = [];
  const counts = new Map<string, number>();
  const push: Push = (finding) => {
    const base = `${finding.code}:${finding.target ?? '-'}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    if (found.length < REVIEW_LIMITS.findings) found.push({ id: n === 1 ? base : `${base}:${n}`, ...finding });
  };
  if (content && typeof content === 'object') {
    if (type === 'brief') briefReview(content as Brief, push);
    if (type === 'process') processReview(content as BusinessProcess, push);
    if (type === 'features') featuresReview(content as AppFeatures, push);
    if (type === 'screens') screensReview(content as AppScreens, context.features ?? null, push);
    if (type === 'sitemap') sitemapReview(content as Sitemap, push);
    if (type === 'content') contentReview(content as ContentArtifact, push);
    if (type === 'schedule') scheduleReview(content as Schedule, push);
    if (type === 'catalog') catalogReview(content as Catalog, push);
    if (type === 'techplan' && Array.isArray((content as TechPlan).dataModel)) techPlanReview(content as TechPlan, push);
  }
  found.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const score = Math.max(0, 100 - found.reduce((sum, finding) => sum + WEIGHT[finding.severity], 0));
  return { rulesVersion: REVIEW_RULES_VERSION, score, findings: found, blocking: found.filter((finding) => finding.severity === 'blocking').length };
}

/** Blocking findings not covered by the owner's written explanation for this version. */
export function uncoveredBlocking(review: StageReview, overridden: string[]): ReviewFinding[] {
  const covered = new Set(overridden);
  return review.findings.filter((finding) => finding.severity === 'blocking' && !covered.has(finding.id));
}

/**
 * The instruction for «let the AI finish it»: built from our own finding texts only (never from free user text), so the
 * AI is told exactly which problems to fix and to keep everything else as it is.
 */
export function fixInstruction(findings: ReviewFinding[]): string {
  // Whole lines only, within the length of a stored instruction; the rest is fixed in the next round.
  let out = tr('Исправь только эти замечания проверки, остальное оставь как есть:');
  findings.forEach((finding, index) => {
    const line = `\n${index + 1}. ${finding.where}: ${finding.message} ${finding.fix}`;
    if (out.length + line.length <= REVIEW_LIMITS.instruction) out += line;
  });
  return out;
}
