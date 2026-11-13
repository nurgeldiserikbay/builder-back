import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeDocument, docxParagraphs, DocumentError, pdfParagraphs, textParagraphs } from './document-analysis.js';
import { reportMarkdown, reportView } from './report-view.js';
import { buildZip } from './zip-fixture.js';

const source = { kind: 'stage_file', label: 'tz.docx', revision: null };
const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (body: string) => buildZip([{ name: '[Content_Types].xml', data: '<x/>' }, { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>` }]);

function pdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 20 280 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj${body}endobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

describe('document analysis', () => {
  it('reads Word paragraphs and headings, finds sections, vague wording and open questions with paragraph numbers', () => {
    const filler = 'Сайт принимает заявки на торты и показывает цены, фото работ и отзывы клиентов. '.repeat(12);
    const bytes = docx([
      para('Техническое задание', 'Title'), para('Цель проекта', 'Heading1'), para(`Нужен удобный и современный сайт. ${filler}`),
      para('Для кого', 'Heading1'), para('Родители и компании в Алматы.'), para('Функции', 'Heading1'), para('Заявка, каталог, отзывы и т.д.'),
      para('Сроки', 'Heading1'), para('Запуск — уточнить с заказчиком. Контакт: aigerim@example.com, +7 701 123 45 67'),
    ].join(''));
    const paragraphs = docxParagraphs(bytes);
    assert.equal(paragraphs.length, 9);
    assert.equal(paragraphs.filter((item) => item.heading).length, 5);
    const report = analyzeDocument({ paragraphs, bytes, source, format: 'docx' });
    assert.equal(report.type, 'document');
    const codes = report.findings.map((finding) => finding.code);
    for (const code of ['DOC_VAGUE_WORDING', 'DOC_OPEN_QUESTIONS', 'DOC_PERSONAL_DATA', 'DOC_SECTION_MISSING']) assert.ok(codes.includes(code), code);
    assert.ok(!codes.includes('DOC_TOO_SHORT') && !codes.includes('DOC_NO_STRUCTURE'));
    assert.deepEqual(report.findings.find((finding) => finding.code === 'DOC_VAGUE_WORDING')!.evidence.map((item) => item.line), [3, 7]);
    assert.deepEqual(report.findings.find((finding) => finding.code === 'DOC_OPEN_QUESTIONS')!.evidence, [{ path: 'tz.docx', line: 9 }]);
    const missing = report.findings.filter((finding) => finding.code === 'DOC_SECTION_MISSING').map((finding) => finding.params?.section);
    assert.ok(missing.includes('acceptance') && missing.includes('budget') && !missing.includes('goal') && !missing.includes('deadline'));
    const view = reportView(report);
    assert.match(view.findings.find((finding) => finding.code === 'DOC_SECTION_MISSING' && finding.severity === 'medium')!.title, /Критерии приёмки/);
    const markdown = reportMarkdown('Торты', { createdAt: new Date(), finishedAt: null }, report);
    assert.match(markdown, /^# Разбор документа: Торты/);
    assert.match(markdown, /абзац 9/);
  });

  it('reads plain text and PDF text; a PDF without text and a broken file say so plainly', async () => {
    const text = textParagraphs('# Цель\nСайт для заявок\n\n## Аудитория\nРодители\n\nTBD: оплата');
    assert.deepEqual(text.map((item) => [item.text, item.heading]), [['Цель', true], ['Сайт для заявок', false], ['Аудитория', true], ['Родители', false], ['TBD: оплата', false]]);
    const short = analyzeDocument({ paragraphs: text, bytes: Buffer.from('x'), source: { ...source, label: 'tz.md' }, format: 'text' });
    assert.ok(short.findings.some((finding) => finding.code === 'DOC_TOO_SHORT'));
    const read = await pdfParagraphs(pdf(['Goal: online orders', 'Audience: parents']));
    assert.equal(read.pages, 1);
    assert.equal(read.emptyPages, 0);
    assert.match(read.paragraphs.map((item) => item.text).join(' '), /Goal: online orders/);
    const blank = await pdfParagraphs(pdf([]));
    const scanned = analyzeDocument({ paragraphs: blank.paragraphs, bytes: Buffer.from('x'), source, format: 'pdf', pdf: blank });
    assert.equal(scanned.findings[0]!.code, 'DOC_NO_TEXT');
    assert.equal(scanned.status, 'partial');
    await assert.rejects(pdfParagraphs(Buffer.from('%PDF-1.4 broken')), (error: unknown) => error instanceof DocumentError && error.code === 'DOCUMENT_UNREADABLE');
    assert.throws(() => docxParagraphs(Buffer.from('not a zip')), (error: unknown) => error instanceof DocumentError);
  });
});
