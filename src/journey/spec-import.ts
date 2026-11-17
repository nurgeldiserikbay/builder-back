// «Есть своё ТЗ?»: the owner's own specification, pasted or from a stage file, laid out into the ТЗ stage. Deterministic:
// sections are recognised by their headings, priorities by words like «первая версия» or «позже», «готово, когда» lines
// go to the function above them. What is not found stays empty and shows up as a gap; the AI can fill gaps afterwards.
import { textParagraphs, type Paragraph } from '../analysis/document-analysis.js';
import { tr } from '../i18n/i18n.js';
import { APP_LIMITS, normalizeFeatures, type AppFeature, type AppFeatures, type AppRole, type Priority } from './webapp.js';

type Section = 'summary' | 'roles' | 'features' | 'requirements' | 'limits' | 'questions' | 'other';

// Order matters: «нефункциональные требования» are requirements, «функциональные требования» are features.
const SECTION_WORDS: Array<[Section, RegExp]> = [
  ['questions', /вопрос|questions?/i],
  ['limits', /ограничен|допущен|не входит|вне рамок|за рамками|limits?|assumptions?|out of scope/i],
  ['requirements', /нефункцион|общие требован|требования к (?:скорост|безопас|дизайн|качеств|систем|платформ)|non-functional|general requirements/i],
  ['roles', /роли|роль|пользовател|участник|кто пользуется|актор|целевая аудитор|roles?|users?|actors?/i],
  ['features', /функци|возможност|требован|что умеет|сценари|user stor|истори|features?|functional|requirements?|scope/i],
  ['summary', /цель|описание|о проекте|о продукте|общее|введение|назначение|кратко|summary|overview|introduction|purpose|goal/i],
];
const PRIORITY_WORDS: Array<[Priority, RegExp]> = [
  ['later', /позже|потом|следующ|вторая верси|v2|будущ|later|future|phase 2|nice to have later/i],
  ['should', /желательн|по возможности|дополнительн|should|nice to have|optional/i],
  ['must', /первая верси|mvp|обязательн|must|первый этап|сначала|в первую очередь|first version|core/i],
];
const ACCEPTANCE = /^(?:критери[йи]\s*(?:приёмки|приемки)?|готово,?\s*когда|приёмка|приемка|acceptance|done when)\s*[:—-]?\s*/i;
const BULLET = /^(?:[-*•–]|\d+(?:\.\d+)*[.)])\s+/;

export interface SpecImport { content: AppFeatures; found: { summary: boolean; roles: number; features: number; acceptance: number; requirements: number; limits: number; questions: number } }

const clean = (text: string) => text.replace(BULLET, '').replace(/\s+/g, ' ').trim();
const sectionOf = (heading: string): Section => SECTION_WORDS.find(([, words]) => words.test(heading))?.[0] ?? 'other';
const priorityOf = (text: string): Priority | null => PRIORITY_WORDS.find(([, words]) => words.test(text))?.[0] ?? null;
/** «Клиент — записывается онлайн» → name and description. */
function split(text: string, max: number): [string, string] {
  const match = /^(.{1,80}?)\s*(?:—|–|:|\s-\s)\s*(.+)$/.exec(text);
  if (match) return [match[1]!.slice(0, max), match[2]!];
  const sentence = /^(.{1,80}?[.!])\s+(.+)$/.exec(text);
  return sentence ? [sentence[1]!.replace(/[.!]$/, '').slice(0, max), sentence[2]!] : [text.slice(0, max), ''];
}

const INLINE_ACCEPTANCE = /\s(?=(?:критери[йи]\s*(?:приёмки|приемки)|готово,?\s*когда|acceptance|done when)\s*:)/i;

/** Wrapped lines join into one paragraph; a «Готово, когда:» inside it starts a paragraph of its own. */
function expand(paragraphs: Paragraph[]): Paragraph[] {
  return paragraphs.flatMap((paragraph) => (paragraph.heading ? [paragraph] : paragraph.text.split(INLINE_ACCEPTANCE).map((text) => ({ text, heading: false }))));
}

export function importSpec(input: Paragraph[]): SpecImport {
  const paragraphs = expand(input);
  let section: Section = 'summary';
  let priority: Priority | null = null;
  let seenHeading = false;
  const summary: string[] = [];
  const roles: AppRole[] = [];
  const features: Array<Omit<AppFeature, 'roles' | 'data'> & { text: string }> = [];
  // List items under headings that are none of the ТЗ sections: used as functions only when there is no functions section.
  const loose: typeof features = [];
  const requirements: string[] = [];
  const limits: string[] = [];
  const questions: string[] = [];
  let acceptance = 0;

  for (const paragraph of paragraphs) {
    const text = clean(paragraph.text);
    if (!text) continue;
    // A short numbered item («2. Заказ торта на дату») looks like a heading in plain text; it is an item unless it names a section.
    const numberedItem = paragraph.heading && BULLET.test(paragraph.text.trim()) && sectionOf(text) === 'other' && !priorityOf(text);
    if (paragraph.heading && !numberedItem) {
      const next = sectionOf(text);
      // The document's own title («ТЗ: сайт кондитерской») keeps the opening text as the summary.
      if (next === 'other' && !seenHeading && !summary.length && !/:$/.test(text)) { seenHeading = true; continue; }
      const scope = priorityOf(text);
      // A heading like «Первая версия» or «Позже» inside the functions keeps the functions section and sets the priority.
      if (scope && (section === 'features' || next === 'features' || next === 'other')) { section = 'features'; priority = scope; }
      else { section = next; priority = scope; }
      seenHeading = true;
      continue;
    }
    if (ACCEPTANCE.test(text) && features.length) {
      const last = features[features.length - 1]!;
      for (const line of text.replace(ACCEPTANCE, '').split(/;\s+/)) if (line.trim() && last.acceptance.length < APP_LIMITS.acceptance) { last.acceptance.push(line.trim().slice(0, 200)); acceptance += 1; }
      continue;
    }
    if (/\?$/.test(text) && section !== 'questions') { if (questions.length < APP_LIMITS.notes) questions.push(text.slice(0, 200)); continue; }
    switch (section) {
      case 'summary': {
        // A list under the title is what the product should do rather than a description.
        if (BULLET.test(paragraph.text.trim())) { const [title, description] = split(text, 80); loose.push({ key: `f${loose.length + 1}`, title, description: description.slice(0, 400), priority: priorityOf(text) ?? priority ?? 'must', acceptance: [], text }); break; }
        if (summary.join(' ').length < 600) summary.push(text);
        break;
      }
      case 'roles': if (roles.length < APP_LIMITS.roles) { const [name, description] = split(text, 40); roles.push({ key: `role${roles.length + 1}`, name, description: description.slice(0, 200) }); } break;
      case 'features': case 'other': {
        if (section === 'other' && !BULLET.test(paragraph.text.trim())) break;
        const target = section === 'features' ? features : loose;
        if (target.length >= APP_LIMITS.features) break;
        const [title, description] = split(text, 80);
        target.push({ key: `f${target.length + 1}`, title, description: description.slice(0, 400), priority: priorityOf(text) ?? priority ?? 'must', acceptance: [], text });
        break;
      }
      case 'requirements': if (requirements.length < APP_LIMITS.notes) requirements.push(text.slice(0, 200)); break;
      case 'limits': if (limits.length < APP_LIMITS.notes) limits.push(text.slice(0, 200)); break;
      case 'questions': if (questions.length < APP_LIMITS.notes) questions.push(text.slice(0, 200)); break;
    }
  }

  if (!features.length) features.push(...loose);
  const people = roles.length ? roles : [{ key: 'client', name: tr('Клиент'), description: '' }];
  // A function is used by the roles its text names; when it names none, by the first role, for the owner to correct.
  const withRoles = features.map(({ text, ...feature }) => {
    const named = people.filter((role) => role.name.length > 2 && text.toLowerCase().includes(role.name.toLowerCase().slice(0, Math.max(4, role.name.length - 2))));
    return { ...feature, roles: (named.length ? named : people.slice(0, 1)).map((role) => role.key), data: [] };
  });
  const content = normalizeFeatures({
    summary: summary.join(' ').slice(0, 600), roles: people, features: withRoles, sensitivity: 'personal', integrations: [],
    requirements, limits, questions,
  });
  return {
    content,
    found: { summary: Boolean(content.summary), roles: roles.length, features: content.features.length, acceptance, requirements: content.requirements.length, limits: content.limits.length, questions: content.questions.length },
  };
}

export const importSpecText = (text: string): SpecImport => importSpec(textParagraphs(text));
