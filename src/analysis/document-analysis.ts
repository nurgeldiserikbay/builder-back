// Read-only check of a requirements document (brief, ТЗ) in PDF, Word or plain text. Deterministic rules over the
// text: which usual sections are there, wording that cannot be checked («удобный», «быстро», «и т.д.»), open questions
// («уточнить», «TBD», «???»), and personal data that should stay private. The meaning is not judged and nothing is sent
// to an AI provider. Evidence is the paragraph number in the extracted text.

import { createHash } from 'node:crypto';
import { listZipEntries, readZipEntry, ZipError } from './zip-reader.js';
import type { AnalysisReport, Evidence, Finding, Severity } from './code-analysis.js';

import { extractRequirements } from './requirements-match.js';
export const DOCUMENT_PROFILE = 'document-1.0';
export const DOCUMENT_LIMITS = { xmlBytes: 8 * 1024 * 1024, pdfPages: 200, paragraphs: 5000, scanChars: 2000, evidence: 10 };

export class DocumentError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type Paragraph = { text: string; heading: boolean };

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
  if (code[0] === '#') { const point = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : ''; }
  return entities[code.toLowerCase()] ?? '';
});

/** Paragraphs of word/document.xml: text runs, tabs and breaks; headings by paragraph style or outline level. */
export function docxParagraphs(buffer: Buffer): Paragraph[] {
  let entries;
  try { entries = listZipEntries(buffer); } catch (error) { throw error instanceof ZipError ? new DocumentError('DOCUMENT_UNREADABLE') : error; }
  const entry = entries.find((item) => item.name === 'word/document.xml');
  if (!entry) throw new DocumentError('DOCUMENT_UNREADABLE');
  const read = readZipEntry(buffer, entry, DOCUMENT_LIMITS.xmlBytes);
  if ('skipped' in read) throw new DocumentError(read.skipped === 'too_large' || read.skipped === 'ratio' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_UNREADABLE');
  const xml = read.data.toString('utf8');
  const paragraphs: Paragraph[] = [];
  for (const match of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const block = match[0];
    const text = decodeXml(block.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_, inner: string | undefined) => inner ?? '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? '';
    const heading = /^(heading|title|заголовок)/i.test(style) || /<w:outlineLvl w:val="\d"/.test(block);
    paragraphs.push({ text, heading });
    if (paragraphs.length >= DOCUMENT_LIMITS.paragraphs) break;
  }
  return paragraphs;
}

/** Paragraphs of plain text or Markdown: blank lines split paragraphs; «#» lines and short lines ending with «:» are headings. */
export function textParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const line = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (line && paragraphs.length < DOCUMENT_LIMITS.paragraphs) paragraphs.push({ text: line, heading: false });
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^#{1,6}\s/.test(line) || (line.length <= 80 && /:$/.test(line)) || /^\d+(?:\.\d+)*[.)]?\s+\p{Lu}[^.!?]{0,70}$/u.test(line);
    if (heading) {
      flush();
      if (paragraphs.length < DOCUMENT_LIMITS.paragraphs) paragraphs.push({ text: line.replace(/^#{1,6}\s+/, ''), heading: true });
      continue;
    }
    if (/^([-*•]|\d+[.)])\s/.test(line)) flush();
    buffer.push(line);
  }
  flush();
  return paragraphs;
}

/** Text of a PDF page by page. pdf.js runs without eval of font programs; scanned pages give no text. */
export async function pdfParagraphs(buffer: Buffer): Promise<{ paragraphs: Paragraph[]; pages: number; emptyPages: number }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pages: string[];
  let total = 0;
  try {
    const document = await getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false, verbosity: 0, disableFontFace: true, useSystemFonts: false } as never);
    total = document.numPages;
    if (total > DOCUMENT_LIMITS.pdfPages) throw new DocumentError('DOCUMENT_TOO_LARGE');
    pages = (await extractText(document, { mergePages: false })).text as string[];
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('DOCUMENT_UNREADABLE');
  }
  const paragraphs = pages.flatMap((page) => textParagraphs(page));
  return { paragraphs: paragraphs.slice(0, DOCUMENT_LIMITS.paragraphs), pages: total, emptyPages: pages.filter((page) => !page.trim()).length };
}

/** Usual sections of a brief for a site or an app. Found by words in headings first, then anywhere in the text. */
export const sectionRules: { key: string; words: RegExp }[] = [
  { key: 'goal', words: /(?<![\p{L}])(цел[ьи]|задач[аи] проекта|назначение|goal|purpose|objective)/iu },
  { key: 'audience', words: /(?<![\p{L}])(аудитори|пользовател|клиент|роли|целев|audience|users?|personas?)/iu },
  { key: 'features', words: /(?<![\p{L}])(функци|возможност|требовани|сценари|features?|requirements?|user stor)/iu },
  { key: 'pages', words: /(?<![\p{L}])(страниц|разделы сайта|структур|экран|карта сайта|pages?|screens?|sitemap)/iu },
  { key: 'content', words: /(?<![\p{L}])(контент|тексты|наполнени|материал|content|copy)/iu },
  { key: 'design', words: /(?<![\p{L}])(дизайн|оформлени|стиль|макет|бренд|design|branding|style)/iu },
  { key: 'integrations', words: /(?<![\p{L}])(интеграц|оплат|crm|1с|api|интеграции|payments?|integrations?)/iu },
  { key: 'deadline', words: /(?<![\p{L}])(срок|дедлайн|этапы работ|график|deadline|timeline|milestone)/iu },
  { key: 'budget', words: /(?<![\p{L}])(бюджет|стоимост|цена работ|budget|cost)/iu },
  { key: 'acceptance', words: /(?<![\p{L}])(критери[йи] приёмки|критери[йи] приемки|приёмк|приемк|acceptance|definition of done)/iu },
];

const vague = /(?<![\p{L}])(удобн\p{L}*|красив\p{L}*|современн\p{L}*|быстр\p{L}*|интуитивн\p{L}*|простой|простая|простое|качественн\p{L}*|надёжн\p{L}*|надежн\p{L}*|стильн\p{L}*|и т\.\s?д\.|и т\.\s?п\.|по возможности|при необходимости|и другие|и др\.|user-friendly|modern|fast|intuitive|etc\.)(?![\p{L}])/iu;
const openQuestion = /(?<![\p{L}])(уточнить|уточняется|обсудить|под вопросом|не решено|tbd|todo|tba|\?\?\?)(?![\p{L}])/iu;
const email = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/u;
const phone = /(?:\+?7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/;
const iin = /(?<!\d)\d{12}(?!\d)/;

export function analyzeDocument(input: { paragraphs: Paragraph[]; bytes: Buffer; source: { kind: string; label: string; revision: string | null }; format: 'pdf' | 'docx' | 'text'; pdf?: { pages: number; emptyPages: number } }): AnalysisReport {
  const { paragraphs } = input;
  const path = input.source.label;
  const findings: Finding[] = [];
  const add = (code: string, category: Finding['category'], severity: Severity, evidence: Evidence[], confidence: Finding['confidence'] = 'confirmed', params?: Finding['params']) => {
    findings.push({ id: `${code}-${createHash('sha256').update(`${code}|${JSON.stringify(params ?? {})}|${evidence.map((item) => item.line ?? '').join(',')}`).digest('hex').slice(0, 8)}`, code, category, severity, confidence, evidence: evidence.slice(0, DOCUMENT_LIMITS.evidence), params: { count: evidence.length, ...params } });
  };
  const at = (index: number): Evidence => ({ path, line: index + 1 });
  const words = paragraphs.reduce((sum, item) => sum + item.text.split(/\s+/).filter(Boolean).length, 0);
  const headings = paragraphs.map((item, index) => ({ ...item, index })).filter((item) => item.heading);

  if (input.format === 'pdf' && input.pdf && input.pdf.pages > 0 && input.pdf.emptyPages === input.pdf.pages) add('DOC_NO_TEXT', 'docs', 'high', [{ path }]);
  else if (words < 150) add('DOC_TOO_SHORT', 'docs', 'medium', [{ path }], 'confirmed', { words });
  if (paragraphs.length >= 8 && headings.length === 0) add('DOC_NO_STRUCTURE', 'docs', 'low', [{ path }]);

  const sections = sectionRules.map((rule) => {
    const inHeading = headings.find((item) => rule.words.test(item.text));
    const inText = inHeading ? null : paragraphs.findIndex((item) => rule.words.test(item.text.slice(0, DOCUMENT_LIMITS.scanChars)));
    return { key: rule.key, found: Boolean(inHeading) || (inText !== null && inText >= 0), paragraph: inHeading ? inHeading.index + 1 : inText !== null && inText >= 0 ? inText + 1 : null };
  });
  if (words >= 30) {
    for (const section of sections.filter((item) => !item.found)) {
      const important = ['goal', 'audience', 'features', 'acceptance'].includes(section.key);
      add('DOC_SECTION_MISSING', 'quality', important ? 'medium' : 'low', [{ path }], 'likely', { section: section.key });
    }
  }
  const scan = (pattern: RegExp) => paragraphs.flatMap((item, index) => (pattern.test(item.text.slice(0, DOCUMENT_LIMITS.scanChars)) ? [index] : []));
  const vagueAt = scan(vague);
  if (vagueAt.length) add('DOC_VAGUE_WORDING', 'quality', vagueAt.length >= 5 ? 'medium' : 'low', vagueAt.map(at), 'likely');
  const openAt = scan(openQuestion);
  if (openAt.length) add('DOC_OPEN_QUESTIONS', 'quality', 'medium', openAt.map(at));
  const personalAt = paragraphs.flatMap((item, index) => (email.test(item.text) || phone.test(item.text) || iin.test(item.text) ? [index] : []));
  if (personalAt.length) add('DOC_PERSONAL_DATA', 'security', 'info', personalAt.map(at), 'likely');

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
  const scanned = input.format === 'pdf' && (input.pdf?.emptyPages ?? 0) > 0;
  return {
    type: 'document',
    profile: DOCUMENT_PROFILE,
    source: { ...input.source, sha256: createHash('sha256').update(input.bytes).digest('hex'), bytes: input.bytes.length },
    status: scanned || paragraphs.length >= DOCUMENT_LIMITS.paragraphs ? 'partial' : 'succeeded',
    summary: {
      files: 1, directories: 0, textFilesRead: 1, lines: paragraphs.length, languages: [], stack: [], routes: [],
      readmeExcerpt: paragraphs.slice(0, 6).map((item) => item.text).join('\n').slice(0, 800) || null,
    },
    document: { format: input.format, words, paragraphs: paragraphs.length, pages: input.pdf?.pages ?? null, headings: headings.slice(0, 40).map((item) => item.text.slice(0, 120)), sections, requirements: extractRequirements(paragraphs) },
    findings,
    checks: [
      { key: 'doc_text', status: scanned ? 'partial' : 'run' },
      { key: 'doc_sections', status: 'run' },
      { key: 'doc_wording', status: 'run' },
      { key: 'doc_open_questions', status: 'run' },
      { key: 'doc_meaning', status: 'skipped' },
    ],
    skipped: { encrypted: 0, tooLarge: 0, binary: 0, budget: 0, unsafe: 0, corrupt: 0, longLines: 0 },
    unverified: ['doc_meaning', 'doc_images', ...(scanned ? ['doc_scanned'] : [])],
  };
}
