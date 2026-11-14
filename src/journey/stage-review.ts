// Quality review of a stage result: deterministic rules for logic gaps and weak spots that a later stage would trip over.
// Completeness (artifacts.ts) says what is missing; the review says what does not fit together or is risky.
// A blocking finding stops acceptance until it is fixed or the owner explains in writing why the stage goes on anyway.
import { tr } from '../i18n/i18n.js';
import { keywords } from '../analysis/requirements-match.js';
import type { Brief } from './artifacts.js';
import type { BusinessProcess } from './process.js';
import type { AppFeatures, AppScreens } from './webapp.js';

export const REVIEW_RULES_VERSION = '1.0.0';
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
