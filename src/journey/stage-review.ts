// Quality review of a stage result: deterministic rules for logic gaps and weak spots that a later stage would trip over.
// Completeness (artifacts.ts) says what is missing; the review says what does not fit together or is risky.
// A blocking finding stops acceptance until it is fixed or the owner explains in writing why the stage goes on anyway.
import { designIssues, type ArchitectureDesign, type ArchitectureFix } from './architecture.js';
import { templateDesignFor } from './webapp.js';
import { dataNames, screenAccessIssues } from './screen-access.js';
import { contractIssues, type Contracts } from './contracts.js';
import { roadmapIssues, type Roadmap } from './roadmap.js';
import { testPlanIssues, type TestPlan } from './testplan.js';
import { moduleIssues, type ModuleFacts } from './module-stages.js';
import { launchIssues, type LaunchChecklist, type LaunchFacts } from './launch.js';
import { coverage, productSteps } from './spec-extras.js';
import { conceptDocument, undefinedTerms, type Concept, type ConceptInputs } from './concept.js';
import { FIRST_VERSION_EXTRAS, type Suggestions } from './suggestions.js';
import { measurable, type IdeaReview } from './idea.js';
import { tr } from '../i18n/i18n.js';
import { keywords } from '../analysis/requirements-match.js';
import { sectionTypeLabels, type Brief, type Story, type ContentArtifact, type Offer } from './artifacts.js';
import type { Catalog } from './products.js';
import type { Schedule } from './schedule.js';
import type { Sitemap } from './sitemap.js';
import type { TechPlan } from './techplan.js';
import type { BusinessProcess } from './process.js';
import { situationsFor } from './situations.js';
import { FIRST_VERSION_SOFT_LIMIT } from './webapp.js';
import type { AppFeatures, AppScreens } from './webapp.js';

export const REVIEW_RULES_VERSION = '1.5.0';
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
  /** Only the owner can settle it (a decision about the business): «let the AI fix it» does not apply. */
  ownerDecides?: boolean;
  /** A change the editor can make at once when the person presses «Исправить», without the AI. */
  autoFix?: AutoFix;
}

/**
 * One-tap fixes for «Бизнес-процесс»: remove a participant who does nothing, a repeated step or a repeated link, or add
 * the record between two records that have many of each other. The editor applies them to the draft; the result is
 * checked again on save like any edit.
 */
export type AutoFix =
  | { kind: 'remove_actor'; actor: string }
  | { kind: 'remove_step'; scenario: string; step: string }
  | { kind: 'remove_link'; entity: string; to: string }
  | { kind: 'add_junction'; a: string; b: string; name: string }
  /** Architecture: add the platform's typical records, components or threats to the design (architecture.ts). */
  | ArchitectureFix;
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

/** Words a stranger may not know; the essence of an idea is read by people outside the project. */
export const STORY_JARGON = ['mvp', 'api', 'saas', 'crm', 'erp', 'b2b', 'b2c', 'ux', 'ui', 'kpi', 'backend', 'frontend', 'бэкенд', 'бекенд', 'фронтенд', 'лендинг', 'юзер', 'юзеры', 'юзеров', 'дашборд', 'фича', 'фичи', 'стартап'];

/** Sentences of a short text: an end mark followed by a space and a capital letter or a digit starts a new one. */
export function sentenceCount(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/(?<=[.!?…])\s+(?=[\p{Lu}\d«"])/u).filter((part) => part.trim().length > 1).length;
}

export function jargonIn(text: string): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...new Set(words.filter((word) => STORY_JARGON.includes(word)))];
}

/** «Идея своими словами»: the essence is one plain sentence a stranger understands (PRODUCT_LIFECYCLE §4.1). */
function storyReview(story: Story, push: Push) {
  if (story.essence && sentenceCount(story.essence) > 1) push({
    code: 'STORY_ESSENCE_SENTENCES', severity: 'important', category: 'clarity', target: 'essence', where: tr('Суть в одном предложении'),
    message: tr('Суть описана в нескольких предложениях: человек, который вас не знает, может не понять, что главное.'),
    fix: tr('Оставьте одно предложение: что происходит и для кого. Подробности перенесите в рассказ.'),
  });
  if (story.essence && story.essence.trim().length < 25) push({
    code: 'STORY_ESSENCE_SHORT', severity: 'important', category: 'clarity', target: 'essence', where: tr('Суть в одном предложении'),
    message: tr('Суть слишком короткая: по ней не понять, что происходит и для кого.'),
    fix: tr('Допишите, кто что делает и что получает: «жильцы оставляют заявку, а управляющая назначает мастера».'),
  });
  const jargon = jargonIn(`${story.essence} ${story.problem}`);
  if (jargon.length) push({
    code: 'STORY_JARGON', severity: 'minor', category: 'clarity', target: 'essence', where: tr('Суть и задача'),
    message: tr('Есть специальные слова, которые не все поймут: {0}.', [jargon.join(', ')]),
    fix: tr('Замените их простыми словами — так, как объяснили бы знакомому.'),
  });
  if (story.problem && story.essence && story.problem.trim().toLowerCase() === story.essence.trim().toLowerCase()) push({
    code: 'STORY_PROBLEM_SAME', severity: 'minor', category: 'clarity', target: 'problem', where: tr('Какую задачу это решает'),
    message: tr('Задача повторяет суть. Разбору идеи нужна сама задача: что сейчас неудобно, дорого или теряется.'),
    fix: tr('Опишите, что происходит сейчас без вашего продукта.'),
  });
}

/**
 * «Разбор идеи»: a risk with high impact and no decision blocks — it is the owner's call to take it, plan for it or drop
 * the idea. The rest is advice: goals without a number, alternatives the AI suggested and nobody confirmed, a problem that
 * describes the product instead of the pain.
 */
function conceptReview(concept: Concept, inputs: ConceptInputs, push: Push) {
  const document = conceptDocument(inputs, concept, '');
  for (const term of undefinedTerms(document.markdown, concept.glossary)) push({
    code: 'CONCEPT_TERM_UNDEFINED', severity: 'important', category: 'clarity', target: 'glossary', where: tr('Словарь'),
    message: tr('В документе есть «{0}», но в словаре это не объяснено — посторонний может не понять.', [term]),
    fix: tr('Добавьте «{0}» в словарь одной простой фразой или замените слово в тексте.', [term]),
  });
  const empty = document.sections.filter((section) => section.empty && !['notes', 'glossary', 'questions'].includes(section.key));
  if (empty.length) push({
    code: 'CONCEPT_SECTIONS_EMPTY', severity: 'minor', category: 'logic', target: null, where: tr('Разделы'),
    message: tr('Без содержания: {0}. В документе они помечены, почему пусты.', [empty.map((section) => `«${section.title}»`).join(', ')]),
    fix: tr('Если раздел важен читателю, заполните этап, из которого он берётся, и примите его.'),
  });
  if (concept.pitch && concept.pitch.length < 60) push({
    code: 'CONCEPT_PITCH_SHORT', severity: 'minor', category: 'clarity', target: 'pitch', where: tr('В двух словах'),
    message: tr('«В двух словах» слишком коротко: посторонний не поймёт, что это и для кого.'),
    fix: tr('Две-три фразы: что за продукт, для кого и какую проблему решает.'),
  });
}

function suggestionsReview(value: Suggestions, push: Push) {
  const now = value.items.filter((item) => item.decision === 'now');
  if (now.length > FIRST_VERSION_EXTRAS) push({
    code: 'SUGGESTIONS_FIRST_VERSION_GROWS', severity: 'important', category: 'logic', target: 'items', where: tr('Первая версия'), ownerDecides: true,
    message: tr('В первую версию выбрано {0} дополнительных возможностей — она станет дольше и дороже.', [now.length]),
    fix: tr('Оставьте в первой версии то, без чего продукт не работает; остальное — «потом». Добавить после запуска проще, чем убрать.'),
  });
  for (const item of value.items) {
    if (item.source === 'ai' && !item.basis) push({
      code: 'SUGGESTION_NO_BASIS', severity: 'important', category: 'logic', target: item.key, where: tr('Предложения функций'),
      message: tr('ИИ предложил «{0}», но не объяснил, из какого шага или цели это следует.', [item.title]),
      fix: tr('Уберите предложение или напишите, зачем оно нужно вашему делу.'),
    });
    if (item.decision === 'now' && item.support === 'not_yet') push({
      code: 'SUGGESTION_NOT_BUILT_YET', severity: 'minor', category: 'logic', target: item.key, where: tr('Предложения функций'), ownerDecides: true,
      message: tr('«{0}» платформа пока не делает — в ТЗ это будет задачей для разработчика.', [item.title]),
      fix: tr('Оставьте, если готовы привлечь разработчика, или перенесите в «потом».'),
    });
    if (item.decision === 'now' && item.support === 'account') push({
      code: 'SUGGESTION_NEEDS_ACCOUNT', severity: 'minor', category: 'logic', target: item.key, where: tr('Предложения функций'), ownerDecides: true,
      message: tr('Для «{0}» нужен ваш аккаунт в стороннем сервисе; у сервиса могут быть свои тарифы.', [item.title]),
      fix: tr('Подключим только с вашего согласия, когда дойдём до запуска.'),
    });
    if (item.decision === 'no' && !item.reason) push({
      code: 'SUGGESTION_NO_REASON', severity: 'minor', category: 'clarity', target: item.key, where: tr('Предложения функций'),
      message: tr('Для «{0}» не записано, почему не нужно.', [item.title]),
      fix: tr('Одной фразой: «клиенты платят на месте», «филиал один». Через полгода это поможет не спорить заново.'),
    });
  }
}

function ideaReview(idea: IdeaReview, push: Push) {
  for (const risk of idea.risks) {
    if (risk.impact === 'high' && risk.decision === 'open') push({
      code: 'IDEA_RISK_HIGH_OPEN', severity: 'blocking', category: 'logic', target: risk.key, where: tr('Риски'), ownerDecides: true,
      message: tr('Риск с высоким влиянием без решения: «{0}».', [risk.text]),
      fix: tr('Решите: принимаете его сознательно, есть план (опишите какой) или идею нужно поменять.'),
    });
  }
  for (const metric of idea.metrics) {
    if (!measurable(metric.text)) push({
      code: 'IDEA_METRIC_NOT_MEASURABLE', severity: 'important', category: 'clarity', target: metric.key, where: tr('Цели успеха'),
      message: tr('Цель «{0}» нельзя измерить.', [metric.text]),
      fix: tr('Добавьте число и срок: «50 заявок в месяц через полгода», «повторные заказы у 30% клиентов».'),
    });
  }
  for (const alternative of idea.alternatives) {
    if (alternative.source === 'ai' && !alternative.confirmed) push({
      code: 'IDEA_ALTERNATIVE_UNCONFIRMED', severity: 'minor', category: 'clarity', target: alternative.key, where: tr('Альтернативы'), ownerDecides: true,
      message: tr('«{0}» предложил ИИ — в документы попадёт, только если вы подтвердите.', [alternative.name]),
      fix: tr('Отметьте «подтверждаю», если так и есть, или уберите.'),
    });
  }
  if (!idea.alternatives.length) push({
    code: 'IDEA_NO_ALTERNATIVES', severity: 'minor', category: 'logic', target: 'alternatives', where: tr('Альтернативы'),
    message: tr('Не указано, как люди справляются сейчас.'),
    fix: tr('Напишите хотя бы одну альтернативу: конкурент, звонок, Instagram, «терпят». Если её нет — так и напишите: это тоже важно.'),
  });
  if (idea.problem && /(приложени|платформ|сайт|сервис|бот)/i.test(idea.problem) && idea.problem.length < 160) push({
    code: 'IDEA_PROBLEM_IS_PRODUCT', severity: 'minor', category: 'clarity', target: 'problem', where: tr('Проблема'),
    message: tr('Проблема описывает продукт, а не боль клиентов.'),
    fix: tr('Напишите, что плохо у людей сейчас: «ждут ответа часами», «не знают, свободен ли мастер».'),
  });
  if (!idea.revenue) push({
    code: 'IDEA_NO_REVENUE', severity: 'minor', category: 'logic', target: 'revenue', where: tr('Как зарабатывает'),
    message: tr('Не указано, как продукт зарабатывает или что экономит.'),
    fix: tr('Цена, подписка, комиссия — или для внутреннего инструмента: сколько времени и денег экономит.'),
  });
  for (const segment of idea.segments) {
    if (segment.name && !segment.need) push({
      code: 'IDEA_SEGMENT_NO_NEED', severity: 'minor', category: 'clarity', target: segment.key, where: tr('Для кого'),
      message: tr('Для группы «{0}» не указано, что ей нужно.', [segment.name]),
      fix: tr('Одной фразой: какую задачу эти люди хотят решить.'),
    });
  }
  if (!idea.risks.length) push({
    code: 'IDEA_NO_RISKS', severity: 'minor', category: 'logic', target: 'risks', where: tr('Риски'),
    message: tr('Нет ни одного риска или допущения.'),
    fix: tr('Каждый продукт на чём-то держится: «клиенты готовы платить заранее», «мастера будут отмечать заказы». Запишите главное.'),
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
      ...(process.scenarios.length ? { autoFix: { kind: 'remove_actor' as const, actor: actor.key } } : {}),
    });
  }
  for (const scenario of process.scenarios) {
    if (!scenario.goal.trim()) push({
      code: 'PROCESS_SCENARIO_NO_RESULT', severity: 'important', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('Не сказано, чем сценарий заканчивается — непонятно, когда он выполнен.'),
      fix: tr('Опишите результат: что получает клиент или бизнес в конце.'),
    });
    scenario.steps.forEach((step, index) => {
      const previous = scenario.steps[index - 1];
      if (previous && step.action.trim() && previous.actor === step.actor && previous.action.trim().toLowerCase() === step.action.trim().toLowerCase()) push({
        code: 'PROCESS_STEP_REPEATED', severity: 'minor', category: 'clarity', target: step.key, where: tr('Сценарий «{0}»', [scenario.title]),
        message: tr('Шаг «{0}» идёт дважды подряд.', [step.action]),
        fix: tr('Уберите повтор или опишите, чем второй шаг отличается.'),
        autoFix: { kind: 'remove_step', scenario: scenario.key, step: step.key },
      });
      if (step.capability === 'other' && step.action.trim()) push({
        code: 'PROCESS_STEP_OTHER', severity: 'minor', category: 'clarity', target: step.key, where: tr('Сценарий «{0}»', [scenario.title]),
        message: tr('Шаг «{0}» отмечен как «Другое» — платформа не поймёт, что для него построить.', [step.action]),
        fix: tr('Выберите в списке, что делает шаг; «Другое» оставьте только для того, чего в списке правда нет.'),
      });
    });
    if (scenario.steps.length >= 2 && new Set(scenario.steps.map((step) => step.actor)).size === 1) push({
      code: 'PROCESS_SCENARIO_ONE_ACTOR', severity: 'minor', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('Все шаги делает один участник: никто не отвечает и не получает результат.'),
      fix: tr('Добавьте, кто реагирует: сайт подтверждает, владелец получает уведомление, клиент видит статус.'),
    });
    if (scenario.steps.length === 1) push({
      code: 'PROCESS_SCENARIO_ONE_STEP', severity: 'minor', category: 'logic', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
      message: tr('В сценарии один шаг: обычно кто-то должен ответить или подтвердить.'),
      fix: tr('Добавьте, что происходит после первого шага.'),
    });
  }
  const twice = (values: string[]) => new Set(values.map((value) => value.trim().toLowerCase()).filter((value, index, all) => value && all.indexOf(value) !== index));
  const actorTwice = twice(process.actors.map((actor) => actor.name));
  for (const actor of process.actors) if (actorTwice.has(actor.name.trim().toLowerCase())) push({
    code: 'PROCESS_ACTOR_DUPLICATE', severity: 'important', category: 'clarity', target: actor.key, where: tr('Участник «{0}»', [actor.name]),
    message: tr('Два участника называются одинаково — на схеме и в приложении их не различить.'),
    fix: tr('Переименуйте одного или объедините их.'),
  });
  const scenarioTwice = twice(process.scenarios.map((scenario) => scenario.title));
  for (const scenario of process.scenarios) if (scenarioTwice.has(scenario.title.trim().toLowerCase())) push({
    code: 'PROCESS_SCENARIO_DUPLICATE', severity: 'minor', category: 'clarity', target: scenario.key, where: tr('Сценарий «{0}»', [scenario.title]),
    message: tr('Два сценария называются одинаково.'),
    fix: tr('Назовите их по-разному, чтобы было видно, чем они отличаются.'),
  });
  const nameOf = (key: string) => process.data.find((entity) => entity.key === key)?.name ?? key;
  for (const entity of process.data) {
    const seen = new Set<string>();
    for (const link of entity.links) {
      if (seen.has(link.to)) push({
        code: 'PROCESS_LINK_DUPLICATE', severity: 'minor', category: 'clarity', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
        message: tr('Связь с «{0}» указана дважды.', [nameOf(link.to)]),
        fix: tr('Оставьте одну связь.'),
        autoFix: { kind: 'remove_link', entity: entity.key, to: link.to },
      });
      if (seen.has(link.to)) continue;
      seen.add(link.to);
      // Both sides «many»: a database needs a record in between (an order line, a booking of a master…).
      const back = process.data.find((other) => other.key === link.to)?.links.find((item) => item.to === entity.key);
      if (link.kind === 'many' && back?.kind === 'many' && entity.key < link.to) push({
        code: 'PROCESS_MANY_TO_MANY', severity: 'important', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
        message: tr('У «{0}» много «{1}», и у «{1}» много «{0}». Так данные не сохранить без записи между ними.', [entity.name, nameOf(link.to)]),
        fix: tr('Добавьте запись-связку, например «{0} — {1}»: в ней будет, что с чем связано (и количество, если нужно).', [entity.name, nameOf(link.to)]),
        autoFix: { kind: 'add_junction', a: entity.key, b: link.to, name: `${entity.name} — ${nameOf(link.to)}`.slice(0, 40) },
      });
    }
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

/** The checkable parts of the ТЗ: tracing to the process, cases for what must work, access to other people's data. */
function specExtrasReview(value: AppFeatures, process: BusinessProcess | null, push: Push) {
  const traced = value.features.some((feature) => (feature.sources ?? []).length > 0);
  // A ТЗ written before tracing has no sources at all: one finding says so instead of one per step.
  if (process && !traced && productSteps(process).length) push({
    code: 'SPEC_NOT_TRACED', severity: 'important', category: 'logic', target: 'features', where: tr('Покрытие процесса'),
    message: tr('У функций не указано, из каких шагов процесса они вытекают — не видно, всё ли, что делает продукт, описано.'),
    fix: tr('Отметьте у каждой функции её шаги процесса или попросите ИИ разметить ТЗ.'),
  });
  if (process && traced) for (const step of coverage(process, value.features.map((feature) => ({ ...feature, sources: feature.sources ?? [] })))) {
    if (!step.by.length) push({
      code: 'SPEC_STEP_NOT_COVERED', severity: 'important', category: 'logic', target: 'features', where: tr('Покрытие процесса'),
      message: tr('Шаг «{0}» (сценарий «{1}») делает продукт, но ни одна функция ТЗ его не описывает.', [step.action, step.scenario]),
      fix: tr('Добавьте функцию или отметьте этот шаг у существующей. Если шаг делается вручную — поменяйте это в процессе.'),
    });
  }
  for (const feature of value.features) {
    if (feature.priority === 'must' && !(feature.cases ?? []).length) push({
      code: 'SPEC_MUST_NO_CASES', severity: 'minor', category: 'clarity', target: feature.key, where: feature.title,
      message: tr('У обязательной функции «{0}» нет проверок «Дано / Когда / Тогда» — по ним потом пишут тесты.', [feature.title]),
      fix: tr('Добавьте обычный путь и случай, когда что-то идёт не так.'),
    });
  }
  const personal = value.sensitivity !== 'normal';
  const clients = new Set((process?.actors ?? []).filter((actor) => actor.kind === 'client').map((actor) => actor.key));
  for (const row of value.access ?? []) {
    if (personal && clients.has(row.role) && row.scope === 'all' && row.actions.includes('view')) push({
      code: 'SPEC_CLIENT_SEES_ALL', severity: 'important', category: 'security', target: 'access', where: tr('Кто что может'),
      message: tr('Роль «{0}» видит все записи «{1}», включая чужие, — а в них личные данные.', [value.roles.find((role) => role.key === row.role)?.name ?? row.role, row.data]),
      fix: tr('Поставьте «только свои» или объясните в ограничениях, почему клиенту нужны чужие записи.'),
    });
  }
}

function featuresReview(value: AppFeatures, process: BusinessProcess | null, push: Push, kind: 'app' | 'site' = 'app') {
  const roleKeys = new Set(value.roles.map((role) => role.key));
  if (process) {
    const known = new Set(['user', ...process.data.map((entity) => entity.key)]);
    for (const feature of value.features) {
      const unknown = (feature.data ?? []).filter((key) => !known.has(key));
      if (unknown.length) push({
        code: 'FEATURES_UNKNOWN_DATA', severity: 'important', category: 'logic', target: feature.key, where: tr('Функция «{0}»', [feature.title]),
        message: tr('Функция работает с данными, которых нет в схеме данных процесса.'),
        fix: tr('Выберите данные из схемы или добавьте их на этапе «Бизнес-процесс».'),
      });
    }
    // Only once the features say which data they use: older results without it are not flooded with findings.
    if (value.features.some((feature) => (feature.data ?? []).length)) {
      for (const entity of process.data) if (!value.features.some((feature) => (feature.data ?? []).includes(entity.key))) push({
        code: 'FEATURES_DATA_UNUSED', severity: 'minor', category: 'logic', target: entity.key, where: tr('Данные «{0}»', [entity.name]),
        message: tr('Эти данные есть в процессе, но ни одна функция с ними не работает — их некому создавать и смотреть.'),
        fix: tr('Отметьте функцию, которая работает с этими данными, или уберите их из процесса.'),
      });
    }
  }
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
      message: tr('У роли нет ни одной функции — ей нечего делать в продукте.'),
      fix: tr('Добавьте функции для этой роли или уберите её.'),
    });
  }
  const allText = value.features.map((feature) => [feature.title, feature.description, ...feature.acceptance].join(' ')).join(' ');
  if ((value.sensitivity === 'personal' || value.sensitivity === 'health') && !overlaps(allText, CONSENT_RULE)) push({
    code: 'FEATURES_PERSONAL_NO_PRIVACY', severity: 'blocking', category: 'security', target: 'sensitivity', where: tr('Чувствительность данных'),
    message: kind === 'app' ? tr('Приложение хранит личные данные, но нет функции согласия на обработку и удаления данных по просьбе.') : tr('Сайт собирает контакты, но нет функции согласия на обработку данных и удаления по просьбе.'),
    fix: kind === 'app' ? tr('Добавьте обязательную функцию: согласие при регистрации и удаление аккаунта с данными.') : tr('Добавьте обязательную функцию: согласие на обработку данных в форме и удаление данных по просьбе.'),
  });
  if (value.sensitivity === 'payments' && !overlaps(allText, PAYMENT_CONFIRM)) push({
    code: 'FEATURES_PAYMENT_NO_CONFIRM', severity: 'blocking', category: 'security', target: 'sensitivity', where: tr('Чувствительность данных'),
    message: tr('Есть платежи, но нет функции подтверждения оплаты, чека и возврата.'),
    fix: tr('Добавьте функцию: подтверждение оплаты, чек и возврат денег.'),
  });
  // The first version: a soft limit — the owner decides, the review only says what a big first version costs.
  const must = value.features.filter((feature) => feature.priority === 'must').length;
  const limit = FIRST_VERSION_SOFT_LIMIT[kind];
  if (must > limit) push({
    code: 'SPEC_FIRST_VERSION_LARGE', severity: 'important', category: 'logic', target: 'features', where: tr('Первая версия'),
    message: tr('В первую версию отмечено функций: {0}. Такая версия выйдет дольше и дороже, а клиенты увидят её позже.', [must]),
    fix: tr('Обычно запускаются с {0} главными функциями, без которых продукт не работает, а остальное делают следующими версиями. Переведите часть функций в «Желательно» или «Позже» — или оставьте, если все они действительно нужны сразу.', [limit]),
  });
  for (const [index, question] of (value.questions ?? []).entries()) push({
    code: 'SPEC_OPEN_QUESTION', severity: 'minor', category: 'clarity', target: `question:${index}`, where: tr('Открытые вопросы'),
    message: question,
    fix: tr('Решите вопрос и уберите его из списка или перенесите решение в функции и ограничения.'),
    ownerDecides: true,
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

function offerReview(offer: Offer, push: Push) {
  const names = new Map<string, number>();
  for (const service of offer.services) names.set(service.name.trim().toLowerCase(), (names.get(service.name.trim().toLowerCase()) ?? 0) + 1);
  offer.services.forEach((service, index) => {
    if (service.name && (names.get(service.name.trim().toLowerCase()) ?? 0) > 1) push({
      code: 'OFFER_DUPLICATE_NAME', severity: 'important', category: 'clarity', target: `service-${index}`, where: tr('Услуга «{0}»', [service.name]),
      message: tr('Две услуги называются одинаково — клиент не поймёт, чем они отличаются.'),
      fix: tr('Объедините их или уточните названия.'),
    });
  });
  const noPrice = offer.services.filter((service) => !service.price?.trim());
  if (offer.services.length && noPrice.length === offer.services.length) push({
    code: 'OFFER_NO_PRICES', severity: 'important', category: 'clarity', target: 'services', where: tr('Услуги'),
    message: tr('Ни у одной услуги нет цены — это первое, что спрашивают клиенты.'),
    fix: tr('Укажите цену или «от …» хотя бы для основных услуг.'),
  });
  else if (noPrice.length) push({
    code: 'OFFER_SOME_PRICES_MISSING', severity: 'minor', category: 'clarity', target: 'services', where: tr('Услуги'),
    message: tr('Без цены: {0}.', [noPrice.slice(0, 4).map((service) => service.name).join(', ')]),
    fix: tr('Укажите цену или напишите, от чего она зависит.'),
  });
  const bare = offer.services.filter((service) => !service.description?.trim());
  if (offer.services.length >= 2 && bare.length === offer.services.length) push({
    code: 'OFFER_NO_DESCRIPTIONS', severity: 'minor', category: 'clarity', target: 'services', where: tr('Услуги'),
    message: tr('У услуг нет описаний — по одному названию трудно выбрать.'),
    fix: tr('Добавьте к каждой услуге одну фразу: что входит и для кого.'),
  });
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

/**
 * «Вы это учли?»: every question of this kind of business without an answer is a finding of the question's level. «Decide
 * later» softens an important or minor question to minor; a blocking one stays blocking until answered or explained.
 */
function situationsReview(process: BusinessProcess, projectType: string | null | undefined, push: Push) {
  const answers = new Map((process.situations ?? []).map((item) => [item.key, item.answer]));
  for (const situation of situationsFor(projectType)) {
    const answer = answers.get(situation.key);
    if (answer && answer !== 'later') continue;
    const severity = answer === 'later' && situation.level !== 'blocking' ? 'minor' : situation.level;
    push({
      code: 'PROCESS_SITUATION_OPEN', severity, category: 'logic', target: `situation:${situation.key}`, where: tr('Вы это учли?'),
      message: tr(situation.question),
      fix: answer === 'later' ? tr('Вы отложили этот вопрос. Решите его, когда будете готовы: ответ станет правилом процесса.') : tr('Выберите ответ или напишите свой: он станет правилом процесса.'),
      ownerDecides: true,
    });
  }
}

/** Review of one stage result. Types without rules yet get an empty review with the full score. */
export function reviewStage(type: string, content: unknown, context: { features?: AppFeatures | null; process?: BusinessProcess | null; projectType?: string | null; concept?: ConceptInputs; design?: ArchitectureDesign | null; contracts?: Contracts | null; launch?: LaunchFacts; module?: ModuleFacts; stack?: string | null } = {}): StageReview {
  const found: ReviewFinding[] = [];
  const counts = new Map<string, number>();
  const push: Push = (finding) => {
    const base = `${finding.code}:${finding.target ?? '-'}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    if (found.length < REVIEW_LIMITS.findings) found.push({ id: n === 1 ? base : `${base}:${n}`, ...finding });
  };
  if (content && typeof content === 'object') {
    if (type === 'story') storyReview(content as Story, push);
    if (type === 'brief') briefReview(content as Brief, push);
    if (type === 'idea') ideaReview(content as IdeaReview, push);
    if (type === 'suggestions') suggestionsReview(content as Suggestions, push);
    if (type === 'techplan') {
      const design = (content as { design?: ArchitectureDesign | null }).design;
      // «Исправить» adds what the platform's first design would have: from the same process and ТЗ.
      const template = design && context.features ? templateDesignFor(context.process ?? null, context.features) : null;
      if (design) for (const issue of designIssues(design, context.features ?? null, template)) push({
        code: issue.code, severity: issue.severity, category: issue.code.startsWith('ARCH_THREAT') ? 'security' : 'logic', target: issue.target, where: tr('Архитектура'), message: issue.message, fix: issue.fix,
        ...(issue.autoFix ? { autoFix: issue.autoFix } : {}),
      });
    }
    if (type === 'launch' && context.launch) for (const issue of launchIssues(content as LaunchChecklist, context.launch)) push({
      code: issue.code, severity: issue.severity, category: issue.code === 'LAUNCH_NO_HTTPS' || issue.code === 'LAUNCH_NO_AUDIT' ? 'security' : 'logic', target: issue.target, where: tr('Подготовка к запуску'), message: issue.message, fix: issue.fix,
    });
    if (type === 'module' && context.module) for (const issue of moduleIssues(context.module)) push({
      code: issue.code, severity: issue.severity, category: 'logic', target: issue.target, where: tr('Модуль'), message: issue.message, fix: issue.fix,
    });
    if (type === 'testplan') for (const issue of testPlanIssues(content as TestPlan, context.features ?? null, context.design ?? null)) push({
      code: issue.code, severity: issue.severity, category: issue.code === 'TESTPLAN_THREAT_UNCOVERED' || issue.code === 'TESTPLAN_SENSITIVE_UNCOVERED' ? 'security' : 'logic', target: issue.target, where: tr('План проверки'), message: issue.message, fix: issue.fix,
    });
    if (type === 'roadmap') for (const issue of roadmapIssues(content as Roadmap, context.features ?? null, context.contracts ?? null, context.stack ?? null)) push({
      code: issue.code, severity: issue.severity, category: 'logic', target: issue.target, where: tr('План реализации'), message: issue.message, fix: issue.fix,
    });
    if (type === 'contracts') for (const issue of contractIssues(content as Contracts, context.features ?? null, context.design ?? null)) push({
      code: issue.code, severity: issue.severity, category: issue.code === 'CONTRACT_OPERATION_OPEN' || issue.code === 'CONTRACT_ROLE_NOT_ALLOWED' ? 'security' : 'logic', target: issue.target, where: tr('Контракты'), message: issue.message, fix: issue.fix,
    });
    if (type === 'concept' && context.concept) conceptReview(content as Concept, context.concept, push);
    if (type === 'process') { processReview(content as BusinessProcess, push); situationsReview(content as BusinessProcess, context.projectType, push); }
    if (type === 'features') featuresReview(content as AppFeatures, context.process ?? null, push, context.projectType && context.projectType !== 'web_app' ? 'site' : 'app');
    if (type === 'features') specExtrasReview(content as AppFeatures, context.process ?? null, push);
    if (type === 'screens') {
      screensReview(content as AppScreens, context.features ?? null, push);
      // The screens against the ТЗ's access matrix: what each role's screens offer must be what the role may do.
      for (const issue of screenAccessIssues(content as AppScreens, context.features ?? null, dataNames(context.process ?? null))) push({
        code: issue.code, severity: issue.severity, category: issue.category, target: issue.target, where: issue.screen ? tr('Экран «{0}»', [issue.screen]) : tr('Экраны'), message: issue.message, fix: issue.fix,
      });
    }
    if (type === 'offer') offerReview(content as Offer, push);
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
export function fixInstruction(findings: Array<Pick<ReviewFinding, 'where' | 'message' | 'fix'>>): string {
  // Whole lines only, within the length of a stored instruction; the rest is fixed in the next round.
  let out = tr('Исправь только эти замечания проверки, остальное оставь как есть:');
  findings.forEach((finding, index) => {
    const line = `\n${index + 1}. ${finding.where}: ${finding.message} ${finding.fix}`;
    if (out.length + line.length <= REVIEW_LIMITS.instruction) out += line;
  });
  return out;
}
