// «Концепция продукта» (builder-docs PRODUCT_LIFECYCLE.md §4.4): one document anyone can read — an investor, a partner, a
// developer, a new employee. The platform assembles it from the accepted stages itself; the owner adds what only they can
// say: the product in two words, the glossary and the open questions. Every section names the stage it comes from, and a
// section with nothing in it says so instead of disappearing. The AI only drafts the owner's parts and reads the document as
// an outsider would; it never writes the sections that come from accepted stages.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError, type Brief } from './artifacts.js';
import type { IdeaReview } from './idea.js';
import { CAPABILITIES, type BusinessProcess } from './process.js';
import { situationQuestions } from './situations.js';
import { estimateFirstVersion, estimateText, type Suggestions } from './suggestions.js';

export const CONCEPT_VERSION = '1.0.0';
export const CONCEPT_LIMITS = { pitch: 600, glossary: 20, term: 40, meaning: 240, questions: 12, question: 240, notes: 1200 };

export interface GlossaryItem { key: string; term: string; meaning: string }
export interface OpenQuestion { key: string; text: string }
export interface Concept { pitch: string; glossary: GlossaryItem[]; questions: OpenQuestion[]; notes: string }

export interface ConceptInputs {
  brief: Brief | null; idea: IdeaReview | null; process: BusinessProcess | null; suggestions: Suggestions | null;
  /** Stages of the route that were skipped on purpose: their sections say so rather than «not filled». */
  skipped: string[];
}
export interface ConceptSection {
  key: string; title: string;
  /** The stage the section comes from, for «откуда это»; null for the owner's own parts. */
  source: string | null;
  markdown: string;
  /** Why the section is empty, said plainly; null when it has content. */
  empty: string | null;
}
/** A diagram the document refers to by number and caption; the print page draws it from the same accepted stage. */
export interface ConceptDiagram { key: 'process' | 'data'; number: number; caption: string }
export interface ConceptDocument { title: string; sections: ConceptSection[]; diagrams: ConceptDiagram[]; markdown: string }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
  return trimmed;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  if (value.length > max) throw new ArtifactValidationError(`FIELD_TOO_MANY:${field}`);
  return value;
}
function keyed<T extends { key: string }>(items: Array<Omit<T, 'key'> & { key?: unknown }>, prefix: string): T[] {
  const used = new Set<string>();
  return items.map((item, index) => {
    let key = typeof item.key === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(item.key) ? item.key : `${prefix}${index + 1}`;
    while (used.has(key)) key = `${key}_`;
    used.add(key);
    return { ...item, key } as T;
  });
}

export function normalizeConcept(raw: unknown): Concept {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const glossary = list(raw.glossary, 'glossary', CONCEPT_LIMITS.glossary).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError(`FIELD_INVALID:glossary.${index}`);
    return { key: item.key, term: text(item.term, `glossary.${index}.term`, CONCEPT_LIMITS.term), meaning: text(item.meaning, `glossary.${index}.meaning`, CONCEPT_LIMITS.meaning) };
  }).filter((item) => item.term);
  const questions = list(raw.questions, 'questions', CONCEPT_LIMITS.questions).map((item, index) => {
    const value = isRecord(item) ? item : { text: item };
    return { key: value.key, text: text(value.text, `questions.${index}`, CONCEPT_LIMITS.question) };
  }).filter((item) => item.text);
  return {
    pitch: text(raw.pitch, 'pitch', CONCEPT_LIMITS.pitch),
    glossary: keyed<GlossaryItem>(glossary, 'g'), questions: keyed<OpenQuestion>(questions, 'q'),
    notes: text(raw.notes, 'notes', CONCEPT_LIMITS.notes),
  };
}

export function conceptIssues(value: Concept): Array<{ key: string; message: string }> {
  const issues: Array<{ key: string; message: string }> = [];
  if (!value.pitch) issues.push({ key: 'pitch', message: tr('Напишите в двух-трёх предложениях, что это за продукт и для кого — с этого начнут читать.') });
  for (const item of value.glossary) if (!item.meaning) issues.push({ key: item.key, message: tr('У термина «{0}» нет объяснения.', [item.term]) });
  return issues;
}

/**
 * Words an outsider stumbles on. Meanings are plain, for the draft glossary; the owner may rewrite them. A word counts as
 * used when it appears as a whole word in the document; the review asks for it in the glossary.
 */
const JARGON: Array<{ term: string; pattern: RegExp; meaning: string }> = [
  { term: 'ТЗ', pattern: /(^|[^а-яё])ТЗ([^а-яё]|$)/, meaning: 'Техническое задание: что должен уметь продукт и как понять, что он готов.' },
  { term: 'MVP', pattern: /\bMVP\b/i, meaning: 'Первая версия продукта с самым нужным, чтобы проверить идею на настоящих клиентах.' },
  { term: 'CRM', pattern: /\bCRM\b/i, meaning: 'Программа, где хранят клиентов, заявки и историю общения с ними.' },
  { term: 'API', pattern: /\bAPI\b/, meaning: 'Способ, которым одна программа обменивается данными с другой.' },
  { term: 'Лендинг', pattern: /лендинг/i, meaning: 'Одностраничный сайт с одним главным действием: оставить заявку, записаться, купить.' },
  { term: 'Конверсия', pattern: /конверси/i, meaning: 'Доля посетителей, которые сделали нужное действие: например, оставили заявку.' },
  { term: 'Личный кабинет', pattern: /личн(ый|ого|ом) кабинет/i, meaning: 'Раздел, куда клиент входит под своим именем и видит свои заказы и данные.' },
  { term: 'Интеграция', pattern: /интеграци/i, meaning: 'Связь продукта с другим сервисом, например с оплатой или бухгалтерией.' },
  { term: 'Платёжный шлюз', pattern: /(платёжн|платежн)\w* шлюз|эквайринг/i, meaning: 'Сервис, через который сайт принимает оплату картой.' },
  { term: 'Роль', pattern: /(^|[^а-яё])рол(ь|и|ей|ям)([^а-яё]|$)/i, meaning: 'Кем человек является в продукте — клиент, сотрудник, владелец — и что ему разрешено.' },
  { term: 'Сценарий', pattern: /сценари/i, meaning: 'Путь человека по шагам от начала до результата, например от выбора услуги до записи.' },
  { term: 'Сегмент', pattern: /сегмент/i, meaning: 'Группа клиентов с похожими задачами.' },
  { term: 'Метрика', pattern: /метрик/i, meaning: 'Число, по которому видно, работает ли продукт: заявки в неделю, доля повторных заказов.' },
  { term: 'Персональные данные', pattern: /персональн\w* данн/i, meaning: 'Сведения о человеке: имя, телефон, адрес. Их хранение регулирует закон.' },
  { term: 'Push-уведомление', pattern: /push/i, meaning: 'Сообщение, которое приходит на телефон от приложения, даже когда оно закрыто.' },
];

/** Jargon used in the text that the glossary does not explain (compared without case). */
export function undefinedTerms(markdown: string, glossary: GlossaryItem[]): string[] {
  const known = new Set(glossary.map((item) => item.term.toLowerCase()));
  return JARGON.filter((word) => word.pattern.test(markdown) && !known.has(word.term.toLowerCase()) && !known.has(tr(word.term).toLowerCase())).map((word) => tr(word.term));
}

const lower = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);
const clean = (value: string) => value.replace(/[.\s]+$/, '');

/** The document from the accepted stages and the owner's parts. Deterministic: the same inputs give the same text. */
export function conceptDocument(input: ConceptInputs, concept: Concept, name: string): ConceptDocument {
  const { brief, idea, process, suggestions } = input;
  const sections: ConceptSection[] = [];
  const diagrams: ConceptDiagram[] = [];
  const skippedWhy = (stage: string, title: string) => input.skipped.includes(stage) ? tr('Этап «{0}» пропущен владельцем.', [title]) : tr('Этап «{0}» ещё не принят.', [title]);
  const add = (key: string, title: string, source: string | null, lines: string[], empty: string) => {
    const markdown = lines.join('\n').trim();
    sections.push({ key, title, source, markdown, empty: markdown ? null : empty });
  };

  add('pitch', tr('В двух словах'), null, [concept.pitch], tr('Владелец ещё не написал, что это за продукт.'));

  const ideaTitle = tr('Разбор идеи');
  const problem: string[] = [];
  if (idea?.problem) problem.push(idea.problem);
  else if (brief) problem.push(tr('{0} — {1}.', [brief.businessName, lower(clean(brief.whatYouDo))]));
  const segments = idea?.segments.filter((segment) => segment.name) ?? [];
  if (segments.length) problem.push('', `**${tr('Для кого')}**`, ...segments.map((segment) => `- ${segment.name}${segment.need ? ` — ${segment.need}` : ''}`));
  else if (brief?.audience) problem.push('', tr('**Для кого:** {0}', [brief.audience]));
  add('problem', tr('Проблема и для кого'), idea ? ideaTitle : tr('Паспорт проекта'), problem, skippedWhy('idea', ideaTitle));

  const value: string[] = [];
  if (idea?.value) value.push(idea.value);
  const alternatives = idea?.alternatives.filter((item) => item.confirmed) ?? [];
  if (alternatives.length) value.push('', `**${tr('Как справляются сейчас')}**`, ...alternatives.map((item) => `- ${item.name}${item.how ? ` — ${item.how}` : ''}`));
  add('value', tr('Почему выберут нас'), ideaTitle, value, idea ? tr('В разборе идеи это не заполнено.') : skippedWhy('idea', ideaTitle));

  const processTitle = tr('Бизнес-процесс');
  const how: string[] = [];
  if (process?.scenarios.length) {
    diagrams.push({ key: 'process', number: diagrams.length + 1, caption: tr('Как идёт работа: кто что делает по шагам') });
    how.push(tr('Схема {0}. {1}.', [diagrams.at(-1)!.number, diagrams.at(-1)!.caption]), '');
    const actor = (key: string) => process.actors.find((item) => item.key === key)?.name ?? key;
    for (const scenario of process.scenarios) {
      how.push(`**${scenario.title}**${scenario.goal ? ` — ${lower(clean(scenario.goal))}` : ''}`);
      scenario.steps.forEach((step, index) => how.push(`${index + 1}. ${actor(step.actor)}: ${lower(clean(step.action))}${step.capability === 'offline' ? ` (${tr('вручную, вне продукта')})` : ''}`));
      how.push('');
    }
    if (process.rules.length) how.push(`**${tr('Правила')}**`, ...process.rules.map((rule) => `- ${rule}`));
  }
  add('how', tr('Как это работает'), processTitle, how, process ? tr('В процессе нет сценариев.') : tr('Этап «{0}» ещё не принят.', [processTitle]));

  const data: string[] = [];
  if (process?.data.length) {
    diagrams.push({ key: 'data', number: diagrams.length + 1, caption: tr('Какие данные хранит продукт и как они связаны') });
    data.push(tr('Схема {0}. {1}.', [diagrams.at(-1)!.number, diagrams.at(-1)!.caption]), '');
    for (const entity of process.data) data.push(`- **${entity.name}**${entity.fields.length ? `: ${entity.fields.join(', ')}` : ''}`);
  }
  add('data', tr('Какие данные хранятся'), processTitle, data, process ? tr('В процессе не описаны данные.') : tr('Этап «{0}» ещё не принят.', [processTitle]));

  const scopeTitle = tr('Предложения функций');
  const scope: string[] = [];
  const now = suggestions?.items.filter((item) => item.decision === 'now') ?? [];
  const later = suggestions?.items.filter((item) => item.decision === 'later') ?? [];
  // What the product does by itself comes from the process steps it takes on; extras chosen on top of that.
  const steps = [...new Set((process?.scenarios ?? []).flatMap((scenario) => scenario.steps).filter((step) => step.capability !== 'offline' && step.capability !== 'other').map((step) => tr(CAPABILITIES[step.capability])))];
  if (steps.length) scope.push(`**${tr('Продукт делает')}**`, ...steps.map((step) => `- ${step}`), '');
  if (now.length) scope.push(`**${tr('Дополнительно в первой версии')}**`, ...now.map((item) => `- ${item.title}${item.value ? ` — ${lower(clean(item.value))}` : ''}`), '');
  // A rough estimate of the extras, labelled as one: by the kind of work, not a quote.
  if (now.length && suggestions) scope.push(tr('Оценка дополнительного по типу работы (не смета): {0}.', [estimateText(estimateFirstVersion(suggestions))]), '');
  if (later.length) scope.push(`**${tr('Потом')}**`, ...later.map((item) => `- ${item.title}`));
  add('scope', tr('Первая версия и что потом'), suggestions ? scopeTitle : processTitle, scope, tr('Состав первой версии определится в ТЗ.'));

  const goals: string[] = [];
  if (idea?.revenue) goals.push(`**${tr('Как зарабатывает или экономит')}.** ${idea.revenue}`, '');
  if (idea?.metrics.length) goals.push(`**${tr('Как поймём, что работает')}**`, ...idea.metrics.map((metric) => `- ${metric.text}`), '');
  if (idea?.risks.length) {
    const decision = { open: tr('не решено'), accepted: tr('риск принят'), mitigate: tr('есть план') };
    goals.push(`**${tr('Риски')}**`, ...idea.risks.map((risk) => `- ${risk.text} — ${decision[risk.decision]}${risk.note ? `: ${lower(clean(risk.note))}` : ''}`));
  }
  add('goals', tr('Деньги, цели и риски'), ideaTitle, goals, idea ? tr('В разборе идеи это не заполнено.') : skippedWhy('idea', ideaTitle));

  const limits = idea ? [[tr('Срок'), idea.constraints.deadline], [tr('Бюджет'), idea.constraints.budget], [tr('Законы и правила'), idea.constraints.legal], [tr('Где хранить данные'), idea.constraints.dataLocation]].filter(([, item]) => item) : [];
  add('limits', tr('Ограничения'), ideaTitle, limits.map(([label, item]) => `- ${label}: ${item}`), idea ? tr('Ограничений не названо.') : skippedWhy('idea', ideaTitle));

  if (concept.notes) add('notes', tr('Что ещё важно'), null, [concept.notes], '');
  add('glossary', tr('Словарь'), null, concept.glossary.map((item) => `- **${item.term}** — ${item.meaning}`), tr('Терминов, которым нужно объяснение, нет.'));
  add('questions', tr('Открытые вопросы'), null, concept.questions.map((item) => `- ${item.text}`), tr('Открытых вопросов нет.'));

  // A name already in quotes («Ноготок») is not quoted again.
  const titleName = brief?.businessName || name;
  const title = /[«»"]/.test(titleName) ? tr('Концепция продукта: {0}', [titleName]) : tr('Концепция продукта «{0}»', [titleName]);
  const markdown = [
    `# ${title}`, '',
    ...sections.flatMap((section) => [`## ${section.title}`, '', section.markdown || `_${section.empty}_`, ...(section.source ? ['', `_${tr('Источник: этап «{0}»', [section.source])}_`] : []), '']),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { title, sections, diagrams, markdown };
}

/** The owner's parts drafted without AI: the pitch from the passport and the idea, jargon that appears, open questions. */
export function templateConcept(input: ConceptInputs, name: string): Concept {
  const { brief, idea, process, suggestions } = input;
  const pitch = [
    brief ? tr('{0} — {1}. Для кого: {2}.', [brief.businessName || name, lower(clean(brief.whatYouDo)), lower(clean(brief.audience))]) : '',
    idea?.problem ? tr('Решает проблему: {0}', [lower(idea.problem)]) : '',
  ].filter(Boolean).join(' ').slice(0, CONCEPT_LIMITS.pitch);
  const draft = conceptDocument(input, { pitch, glossary: [], questions: [], notes: '' }, name);
  const glossary = JARGON.filter((word) => word.pattern.test(draft.markdown)).slice(0, CONCEPT_LIMITS.glossary).map((word) => ({ term: tr(word.term), meaning: tr(word.meaning) }));
  const questions: string[] = [];
  for (const risk of idea?.risks ?? []) if (risk.decision === 'open') questions.push(tr('Как поступим с риском: {0}?', [lower(clean(risk.text))]));
  if (idea && !idea.revenue) questions.push(tr('Как продукт зарабатывает или что экономит?'));
  if (idea && !idea.metrics.length) questions.push(tr('По какому числу поймём, что продукт работает?'));
  const later = (process?.situations ?? []).filter((item) => item.answer === 'later').map((item) => item.key);
  if (later.length) questions.push(...situationQuestions(later));
  for (const item of suggestions?.items ?? []) if (!item.decision) questions.push(tr('Нужно ли: {0}?', [lower(item.title)]));
  return normalizeConcept({ pitch, glossary, questions: questions.slice(0, CONCEPT_LIMITS.questions).map((question) => ({ text: question.slice(0, CONCEPT_LIMITS.question) })), notes: '' });
}

export function conceptChanges(before: Concept, after: Concept): string[] {
  const lines: string[] = [];
  if (before.pitch !== after.pitch) lines.push(tr('Изменено «В двух словах».'));
  const terms = (value: Concept) => new Set(value.glossary.map((item) => item.term));
  const [oldTerms, newTerms] = [terms(before), terms(after)];
  for (const term of newTerms) if (!oldTerms.has(term)) lines.push(tr('В словарь добавлено «{0}».', [term]));
  for (const term of oldTerms) if (!newTerms.has(term)) lines.push(tr('Из словаря убрано «{0}».', [term]));
  const delta = after.questions.length - before.questions.length;
  if (delta > 0) lines.push(tr('Открытых вопросов больше на {0}.', [delta]));
  if (delta < 0) lines.push(tr('Открытых вопросов меньше на {0}.', [-delta]));
  if (before.notes !== after.notes) lines.push(tr('Изменено «Что ещё важно».'));
  return lines;
}

/** A pasted description: the first paragraph becomes «в двух словах», the rest «что ещё важно» — the owner sorts it out. */
export function importConceptText(text: string): Concept {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pitch = (paragraphs.shift() ?? '').slice(0, CONCEPT_LIMITS.pitch);
  return normalizeConcept({ pitch, glossary: [], questions: [], notes: paragraphs.join('\n\n').slice(0, CONCEPT_LIMITS.notes) });
}

/** A file name from a title: letters and digits of any script, spaces as dashes. */
export const slugFile = (title: string) => title.toLowerCase().replace(/[«»"']/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
