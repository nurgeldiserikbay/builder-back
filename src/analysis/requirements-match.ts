// Comparison of a brief (ТЗ) with the accepted results of the project's stages, by words. It says which requirement
// lines of the document have matching words in an accepted stage and which do not — not whether the result really
// does what the line asks. The UI and the export say so.

import type { Paragraph } from './document-analysis.js';

export const REQUIREMENT_LIMITS = { items: 60, chars: 300 };
export type Requirement = { paragraph: number; text: string };

/** Headings under which lines are requirements: functions, pages, content, integrations, acceptance. */
const requirementHeading = /(?<![\p{L}])(функци|возможност|требовани|сценари|страниц|разделы|структур|экран|контент|тексты|наполнени|интеграц|оплат|критери|features?|requirements?|pages?|screens?|content|integrations?|acceptance)/iu;
/** A line that asks for something, outside such headings. */
const asks = /(?<![\p{L}])(должен|должна|должно|должны|нужн[оаы]?|необходимо|требуется|обязательно|предусмотреть|сделать|добавить|реализовать|must|should|needs? to|required)(?![\p{L}])/iu;

/**
 * Lines of the document that state requirements: every line under a requirement heading, and lines that ask for
 * something anywhere else. Very short lines and headings themselves are left out.
 */
export function extractRequirements(paragraphs: Paragraph[]): Requirement[] {
  const items: Requirement[] = [];
  let under = false;
  paragraphs.forEach((item, index) => {
    if (item.heading) { under = requirementHeading.test(item.text); return; }
    const text = item.text.replace(/\s+/g, ' ').trim();
    if (keywords(text).length < 2) return;
    if (under || asks.test(text)) items.push({ paragraph: index + 1, text: text.slice(0, REQUIREMENT_LIMITS.chars) });
  });
  return items.slice(0, REQUIREMENT_LIMITS.items);
}

const stop = new Set(('и в во на с со к ко по о об от до для из за у а но или ли что чтобы как это этот эта эти быть был была были будет будут есть нет не ни все всё весь вся '
  + 'так также тоже его её их мы вы они он она оно наш ваш свой при через над под между который которая которые которое где когда если то же уже ещё очень '
  + 'должен должна должно должны нужно нужна нужен необходимо требуется обязательно предусмотреть сделать добавить реализовать сайт сайта сайте страница '
  + 'the a an and or of to in on for with by is are be must should need needs required site page').split(' '));

// Common Russian endings, so «торты», «тортов» and «торт» are one word; then at most 6 letters.
const ending = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ией|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ам|ям|ах|ях|ом|ем|ую|юю|у|ю|а|я|ы|и|е|о|ь)$/u;
/** Content words, crudely stemmed: lower case, ё → е, Russian endings off, the first 6 letters of what is left. */
export function keywords(text: string): string[] {
  const words = text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
  const stem = (word: string) => {
    const base = word.length > 4 && /^[а-я]+$/.test(word) ? word.replace(ending, '') : word;
    return base.length > 6 ? base.slice(0, 6) : base;
  };
  return [...new Set(words.filter((word) => word.length >= 3 && !stop.has(word)).map(stem))];
}

export type StageText = { key: string; title: string; text: string };
export type RequirementMatch = Requirement & { status: 'found' | 'partial' | 'missing'; stage: { key: string; title: string } | null; matched: string[]; missingWords: string[] };

/**
 * Each requirement against each accepted stage: the share of its content words that appear in the stage. Two thirds
 * or more — found; a third or more — partly; less — not found. The stage with the best share is named.
 */
export function matchRequirements(requirements: Requirement[], stages: StageText[]): RequirementMatch[] {
  const prepared = stages.map((stage) => ({ ...stage, words: new Set(keywords(stage.text)) }));
  return requirements.map((requirement) => {
    const words = keywords(requirement.text);
    let best: { stage: (typeof prepared)[number]; hit: string[] } | null = null;
    for (const stage of prepared) {
      const hit = words.filter((word) => stage.words.has(word));
      if (!best || hit.length > best.hit.length) best = { stage, hit };
    }
    const share = best && words.length ? best.hit.length / words.length : 0;
    const status = share >= 2 / 3 ? 'found' : share >= 1 / 3 ? 'partial' : 'missing';
    return {
      ...requirement, status,
      stage: best && status !== 'missing' ? { key: best.stage.key, title: best.stage.title } : null,
      matched: best && status !== 'missing' ? best.hit : [],
      missingWords: words.filter((word) => !(best && status !== 'missing' && best.hit.includes(word))).slice(0, 8),
    };
  });
}

/** Every string inside an accepted stage result, so texts, services, pages and screens all count. */
export function artifactText(content: unknown, depth = 0): string {
  if (depth > 8 || content === null || content === undefined) return '';
  if (typeof content === 'string') return /^[0-9a-f-]{36}$/i.test(content) || content.length > 20_000 ? '' : content;
  if (Array.isArray(content)) return content.map((item) => artifactText(item, depth + 1)).join(' ');
  if (typeof content === 'object') return Object.entries(content as Record<string, unknown>).filter(([key]) => !['html', 'pages', 'checks', 'quality', 'sourceVersionIds', 'css'].includes(key)).map(([, value]) => artifactText(value, depth + 1)).join(' ');
  return '';
}
