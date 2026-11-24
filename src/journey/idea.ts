// «Разбор идеи» (builder-docs PRODUCT_LIFECYCLE.md §4.2): the idea brought to clarity before money is spent on it —
// the problem and for whom, why people would choose it, how they cope today, how it earns or saves, the assumptions and
// risks taken knowingly, how success is measured and the limits. Nothing is invented: what the person did not say stays
// empty or «не знаю» and becomes a question. Alternatives the AI suggests are marked and count only once confirmed.
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError, type Brief } from './artifacts.js';

export type RiskImpact = 'high' | 'medium' | 'low';
/** open — not decided; accepted — taken knowingly; mitigate — there is a plan (in `note`). */
export type RiskDecision = 'open' | 'accepted' | 'mitigate';
export const RISK_IMPACTS: RiskImpact[] = ['high', 'medium', 'low'];
export const RISK_DECISIONS: RiskDecision[] = ['open', 'accepted', 'mitigate'];

export interface IdeaSegment { key: string; name: string; need: string }
/** How people cope today. source «ai» — suggested by the AI; it goes into documents only once the owner confirms it. */
export interface IdeaAlternative { key: string; name: string; how: string; source: 'owner' | 'ai'; confirmed: boolean }
export interface IdeaRisk { key: string; text: string; impact: RiskImpact; decision: RiskDecision; note: string }
export interface IdeaMetric { key: string; text: string }
export interface IdeaConstraints { deadline: string; budget: string; legal: string; dataLocation: string }
export interface IdeaReview {
  problem: string;
  segments: IdeaSegment[];
  value: string;
  alternatives: IdeaAlternative[];
  revenue: string;
  risks: IdeaRisk[];
  metrics: IdeaMetric[];
  constraints: IdeaConstraints;
}

export const IDEA_LIMITS = { segments: 5, alternatives: 8, risks: 12, metrics: 3 };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ArtifactValidationError(`FIELD_INVALID:${field}`);
  const trimmed = value.replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (trimmed.length > max) throw new ArtifactValidationError(`FIELD_TOO_LONG:${field}`);
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
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);

export function normalizeIdea(raw: unknown): IdeaReview {
  if (!isRecord(raw)) throw new ArtifactValidationError('ARTIFACT_INVALID');
  const keys = { segments: new Set<string>(), alternatives: new Set<string>(), risks: new Set<string>(), metrics: new Set<string>() };
  const segments = list(raw.segments, 'segments', IDEA_LIMITS.segments).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:segments');
    return { key: keyOf(item.key, 'seg', index, keys.segments), name: text(item.name, 'segments', 80), need: text(item.need, 'segments', 300) };
  }).filter((item) => item.name || item.need);
  const alternatives = list(raw.alternatives, 'alternatives', IDEA_LIMITS.alternatives).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:alternatives');
    const source = item.source === 'ai' ? 'ai' as const : 'owner' as const;
    // The owner's own alternatives are confirmed by being written; the AI's wait for a tick.
    return { key: keyOf(item.key, 'alt', index, keys.alternatives), name: text(item.name, 'alternatives', 80), how: text(item.how, 'alternatives', 300), source, confirmed: source === 'owner' ? true : item.confirmed === true };
  }).filter((item) => item.name);
  const risks = list(raw.risks, 'risks', IDEA_LIMITS.risks).map((item, index) => {
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:risks');
    return {
      key: keyOf(item.key, 'risk', index, keys.risks), text: text(item.text, 'risks', 300),
      impact: pick(item.impact, RISK_IMPACTS, 'medium'), decision: pick(item.decision, RISK_DECISIONS, 'open'), note: text(item.note, 'risks', 300),
    };
  }).filter((item) => item.text);
  const metrics = list(raw.metrics, 'metrics', IDEA_LIMITS.metrics).map((item, index) => {
    if (typeof item === 'string') return { key: keyOf(null, 'm', index, keys.metrics), text: text(item, 'metrics', 200) };
    if (!isRecord(item)) throw new ArtifactValidationError('FIELD_INVALID:metrics');
    return { key: keyOf(item.key, 'm', index, keys.metrics), text: text(item.text, 'metrics', 200) };
  }).filter((item) => item.text);
  const limits = isRecord(raw.constraints) ? raw.constraints : {};
  return {
    problem: text(raw.problem, 'problem', 600),
    segments,
    value: text(raw.value, 'value', 600),
    alternatives,
    revenue: text(raw.revenue, 'revenue', 400),
    risks,
    metrics,
    constraints: { deadline: text(limits.deadline, 'constraints', 120), budget: text(limits.budget, 'constraints', 120), legal: text(limits.legal, 'constraints', 300), dataLocation: text(limits.dataLocation, 'constraints', 120) },
  };
}

/** What still keeps the stage from being sent for acceptance. */
export function ideaIssues(idea: IdeaReview): Array<{ key: string; message: string }> {
  const issues: Array<{ key: string; message: string }> = [];
  if (!idea.problem) issues.push({ key: 'problem', message: tr('Опишите, какую проблему решает продукт.') });
  if (!idea.segments.some((segment) => segment.name)) issues.push({ key: 'segments', message: tr('Укажите, для кого продукт: хотя бы одну группу людей.') });
  if (!idea.value) issues.push({ key: 'value', message: tr('Напишите, почему выберут вас, а не то, как люди справляются сейчас.') });
  if (!idea.metrics.length) issues.push({ key: 'metrics', message: tr('Добавьте хотя бы одну цель, по которой будет видно, что продукт работает.') });
  return issues;
}

/** Whether a goal can be measured: a number, a share or a time («20 заявок в неделю», «за 3 месяца»). */
export const measurable = (value: string) => /\d/.test(value);

/** Draft without the AI: what the brief already says, the rest left for the owner — nothing invented. */
export function templateIdea(brief: Brief | null): IdeaReview {
  const audience = brief?.audience?.trim() ?? '';
  return {
    problem: '',
    segments: audience ? [{ key: 'seg1', name: audience.slice(0, 80), need: '' }] : [],
    value: '',
    alternatives: [],
    revenue: '',
    risks: [],
    metrics: [],
    constraints: { deadline: '', budget: '', legal: '', dataLocation: '' },
  };
}

/** Plain lines about what changed between two versions (change notices to the next stages). */
export function ideaChanges(before: IdeaReview, after: IdeaReview): string[] {
  const lines: string[] = [];
  if (before.problem !== after.problem) lines.push(tr('Изменена проблема, которую решает продукт.'));
  if (before.value !== after.value) lines.push(tr('Изменено, почему выберут вас.'));
  if (before.revenue !== after.revenue) lines.push(tr('Изменено, как продукт зарабатывает или экономит.'));
  const names = (items: Array<{ name: string }>) => items.map((item) => item.name);
  for (const name of names(after.segments).filter((name) => !names(before.segments).includes(name))) lines.push(tr('Новая группа пользователей: {0}', [name]));
  for (const name of names(before.segments).filter((name) => !names(after.segments).includes(name))) lines.push(tr('Убрана группа пользователей: {0}', [name]));
  const metrics = (items: IdeaMetric[]) => items.map((item) => item.text);
  for (const text of metrics(after.metrics).filter((text) => !metrics(before.metrics).includes(text))) lines.push(tr('Новая цель: {0}', [text]));
  for (const text of metrics(before.metrics).filter((text) => !metrics(after.metrics).includes(text))) lines.push(tr('Убрана цель: {0}', [text]));
  const risks = (items: IdeaRisk[]) => items.map((item) => item.text);
  for (const text of risks(after.risks).filter((text) => !risks(before.risks).includes(text))) lines.push(tr('Новый риск: {0}', [text]));
  if (JSON.stringify(before.constraints) !== JSON.stringify(after.constraints)) lines.push(tr('Изменены ограничения: срок, бюджет, закон или где хранить данные.'));
  return lines;
}

/** The idea as text for documents: confirmed alternatives only. */
export function ideaMarkdown(idea: IdeaReview): string[] {
  const lines: string[] = [];
  if (idea.problem) lines.push(`**${tr('Проблема')}.** ${idea.problem}`);
  if (idea.segments.length) lines.push('', `**${tr('Для кого')}**`, ...idea.segments.map((segment) => `- ${segment.name}${segment.need ? ` — ${segment.need}` : ''}`));
  if (idea.value) lines.push('', `**${tr('Почему выберут нас')}.** ${idea.value}`);
  const alternatives = idea.alternatives.filter((item) => item.confirmed);
  if (alternatives.length) lines.push('', `**${tr('Как справляются сейчас')}**`, ...alternatives.map((item) => `- ${item.name}${item.how ? ` — ${item.how}` : ''}`));
  if (idea.revenue) lines.push('', `**${tr('Как зарабатывает или экономит')}.** ${idea.revenue}`);
  if (idea.metrics.length) lines.push('', `**${tr('Цели успеха')}**`, ...idea.metrics.map((metric) => `- ${metric.text}`));
  if (idea.risks.length) {
    const decision = { open: tr('не решено'), accepted: tr('принят'), mitigate: tr('есть план') };
    lines.push('', `**${tr('Риски и допущения')}**`, ...idea.risks.map((risk) => `- ${risk.text} (${decision[risk.decision]}${risk.note ? `: ${risk.note}` : ''})`));
  }
  const limits = [[tr('Срок'), idea.constraints.deadline], [tr('Бюджет'), idea.constraints.budget], [tr('Закон'), idea.constraints.legal], [tr('Где хранить данные'), idea.constraints.dataLocation]].filter(([, value]) => value);
  if (limits.length) lines.push('', `**${tr('Ограничения')}**`, ...limits.map(([label, value]) => `- ${label}: ${value}`));
  return lines;
}

type IdeaSection = 'problem' | 'segments' | 'value' | 'alternatives' | 'revenue' | 'risks' | 'metrics' | 'deadline' | 'budget' | 'legal' | 'data';
const SECTION_WORDS: Array<[IdeaSection, RegExp]> = [
  ['problem', /^(проблем|боль|pain|problem)/i],
  ['segments', /^(для кого|целев|аудитор|ца\b|клиент|пользовател|сегмент|audience|segments?|users?|customers?)/i],
  ['value', /^(ценност|почему (мы|нас|выберут)|преимуществ|утп|уникальн|value|why us)/i],
  ['alternatives', /^(конкурент|альтернатив|аналог|как (сейчас|решают)|competitors?|alternatives?)/i],
  ['revenue', /^(монетизац|доход|как зарабат|бизнес.?модел|цен[аы]|экономи|revenue|monetization|business model|pricing)/i],
  ['risks', /^(риск|допущен|гипотез|risks?|assumptions?)/i],
  ['metrics', /^(цел[иь]|метрик|kpi|показател|успех|goals?|metrics?|success)/i],
  ['deadline', /^(срок|дедлайн|deadline|timeline)/i],
  ['budget', /^(бюджет|budget)/i],
  ['legal', /^(закон|юридич|legal|compliance)/i],
  ['data', /^(где хранить|хранение данных|данные хран|data (location|residency))/i],
];

/**
 * An idea written elsewhere (a business plan, a presentation, notes) laid out by its headings. Text under an unknown
 * heading before any known one becomes the problem; nothing is invented. AI-free, so it works without a provider.
 */
export function importIdeaText(text: string): IdeaReview {
  const parts: Partial<Record<IdeaSection, string[]>> = {};
  let section: IdeaSection | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[#>*\-•\s\d.)]+/, '').trim();
    if (!line) continue;
    const [head, ...restParts] = line.split(/[:—–]\s*/);
    const match = SECTION_WORDS.find(([, words]) => words.test(head!.trim()));
    if (match && head!.length <= 40) {
      section = match[0];
      const rest = restParts.join(': ').trim();
      if (rest) (parts[section] ??= []).push(rest);
      continue;
    }
    (parts[section ?? 'problem'] ??= []).push(line);
  }
  const joined = (key: IdeaSection, max: number) => (parts[key] ?? []).join(' ').slice(0, max);
  const items = (key: IdeaSection) => (parts[key] ?? []).flatMap((line) => line.split(/;\s*/)).map((item) => item.trim()).filter(Boolean);
  const split = (item: string) => { const [name, ...how] = item.split(/\s+[—–-]\s+|:\s+/); return { name: name!.slice(0, 80), rest: how.join(' — ').slice(0, 300) }; };
  return normalizeIdea({
    problem: joined('problem', 600),
    segments: items('segments').slice(0, IDEA_LIMITS.segments).map((item) => { const { name, rest } = split(item); return { name, need: rest }; }),
    value: joined('value', 600),
    alternatives: items('alternatives').slice(0, IDEA_LIMITS.alternatives).map((item) => { const { name, rest } = split(item); return { name, how: rest, source: 'owner' }; }),
    revenue: joined('revenue', 400),
    risks: items('risks').slice(0, IDEA_LIMITS.risks).map((item) => ({ text: item.slice(0, 300), impact: 'medium', decision: 'open' })),
    metrics: items('metrics').slice(0, IDEA_LIMITS.metrics).map((item) => ({ text: item.slice(0, 200) })),
    constraints: { deadline: joined('deadline', 120), budget: joined('budget', 120), legal: joined('legal', 300), dataLocation: joined('data', 120) },
  });
}
