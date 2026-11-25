import 'dotenv/config';
import { after, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { projectTypes, stageDefinitions } from './catalog.js';
import { templateProcess } from './process.js';
import { normalizeIdea } from './idea.js';
import { normalizeSuggestions } from './suggestions.js';
import { situationsFor } from './situations.js';
import { reviewStage } from './stage-review.js';
import { buildReviewPrompt } from './stage-ai.js';
import { conceptChanges, conceptDocument, conceptIssues, importConceptText, normalizeConcept, slugFile, templateConcept, undefinedTerms, type ConceptInputs } from './concept.js';
import { markdownToDocx, markdownToDocxXml } from './docx.js';

const brief = { businessName: 'Студия', whatYouDo: 'Маникюр и педикюр', audience: 'Занятые женщины рядом', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@studio', email: null, address: null, tone: 'friendly' } as never;
const full = (): ConceptInputs => ({
  brief, process: templateProcess('booking', null), skipped: [],
  idea: normalizeIdea({ problem: 'Записаться можно только звонком в рабочее время.', segments: [{ name: 'Занятые женщины', need: 'Записаться вечером с телефона' }], value: 'Запись за минуту в любое время.', revenue: 'Оплата услуг в студии', metrics: [{ text: '30 онлайн-записей в неделю' }], risks: [{ text: 'Клиенты не придут', impact: 'high', decision: 'mitigate', note: 'Напоминание за день' }] }),
  suggestions: normalizeSuggestions({ items: [{ title: 'Напоминание клиенту о записи', value: 'Меньше неявок.', decision: 'now' }, { title: 'Отзывы клиентов', decision: 'later' }, { title: 'Выгрузка в Excel', decision: 'no', reason: 'Не нужно' }] }),
});

test('the stage closes the idea phase on every route and is optional', () => {
  for (const type of Object.values(projectTypes)) assert.equal(type.stages[type.stages.indexOf('suggestions') + 1], 'concept', type.key);
  assert.ok(stageDefinitions.concept.optional);
  assert.deepEqual(stageDefinitions.concept.inputs, ['goal', 'idea', 'process', 'suggestions']);
});

test('the document comes from the accepted stages, names its sources and numbers its diagrams', () => {
  const document = conceptDocument(full(), normalizeConcept({ pitch: 'Онлайн-запись в студию маникюра.' }), 'x');
  assert.equal(document.title, 'Концепция продукта «Студия»');
  assert.deepEqual(document.diagrams.map((diagram) => [diagram.key, diagram.number]), [['process', 1], ['data', 2]]);
  assert.match(document.markdown, /Схема 1\. Как идёт работа/);
  assert.match(document.markdown, /Схема 2\. Какие данные/);
  assert.match(document.markdown, /Источник: этап «Разбор идеи»/);
  const scope = document.sections.find((section) => section.key === 'scope')!;
  assert.match(scope.markdown, /Напоминание клиенту о записи/);
  assert.match(scope.markdown, /\*\*Потом\*\*\n- Отзывы клиентов/);
  assert.doesNotMatch(scope.markdown, /Excel/);
  assert.match(document.markdown, /Клиенты не придут — есть план: напоминание за день/);
});

test('a skipped or missing stage leaves its section marked, never silently empty', () => {
  const document = conceptDocument({ brief, idea: null, process: null, suggestions: null, skipped: ['idea', 'suggestions'] }, normalizeConcept({}), 'x');
  for (const section of document.sections) assert.ok(section.markdown || section.empty, section.key);
  assert.equal(document.sections.find((section) => section.key === 'value')!.empty, 'Этап «Разбор идеи» пропущен владельцем.');
  assert.equal(document.sections.find((section) => section.key === 'how')!.empty, 'Этап «Бизнес-процесс» ещё не принят.');
  // Without the idea the problem still comes from the passport.
  assert.match(document.sections.find((section) => section.key === 'problem')!.markdown, /Студия — маникюр и педикюр/);
  assert.match(document.markdown, /_Этап «Разбор идеи» пропущен владельцем\._/);
  assert.equal(document.diagrams.length, 0);
});

test('the draft without AI: a pitch, the jargon it uses and the open questions', () => {
  const inputs = full();
  inputs.idea!.risks.push({ key: 'r2', text: 'Мастера уйдут', impact: 'medium', decision: 'open', note: '' });
  inputs.suggestions!.items.push({ ...inputs.suggestions!.items[0]!, key: 'x', title: 'Онлайн-оплата', decision: '' });
  const draft = templateConcept(inputs, 'x');
  assert.match(draft.pitch, /^Студия — маникюр и педикюр\. Для кого: занятые женщины рядом\./);
  assert.ok(draft.questions.some((question) => question.text === 'Как поступим с риском: мастера уйдут?'));
  assert.ok(draft.questions.some((question) => question.text === 'Нужно ли: онлайн-оплата?'));
  // Every jargon word the document uses is explained, so the draft passes the term check.
  const document = conceptDocument(inputs, draft, 'x');
  assert.deepEqual(undefinedTerms(document.markdown, draft.glossary), []);
  // Jargon from the passport goes into the draft glossary with a plain meaning.
  const crm = templateConcept({ ...inputs, brief: { ...(brief as object), whatYouDo: 'Ведём клиентов в CRM' } as never }, 'x');
  assert.match(crm.glossary.find((item) => item.term === 'CRM')!.meaning, /клиентов/);
  assert.deepEqual(conceptIssues(draft), []);
});

test('the review asks for unexplained words; acceptance needs the pitch; the AI reads the document as an outsider', () => {
  const concept = normalizeConcept({ pitch: 'Коротко про MVP', glossary: [{ term: 'ТЗ', meaning: '' }] });
  assert.deepEqual(conceptIssues(concept).map((issue) => issue.key), ['g1']);
  assert.equal(conceptIssues(normalizeConcept({})).at(0)?.key, 'pitch');
  const codes = reviewStage('concept', concept, { concept: full() }).findings.map((finding) => finding.code);
  assert.ok(codes.includes('CONCEPT_TERM_UNDEFINED'));
  assert.ok(codes.includes('CONCEPT_PITCH_SHORT'));
  const prompt = buildReviewPrompt({ stage: stageDefinitions.concept, locale: 'ru', projectTypeTitle: 'Запись', inputs: {}, current: '# Документ', ruleFindings: [], targets: ['pitch'] });
  assert.match(prompt.system, /never heard of this project/);
  assert.equal(JSON.parse(prompt.user).result, '# Документ');
});

test('Word file: a valid zip with the text escaped; import and changes in plain words', () => {
  const xml = markdownToDocxXml('# Заголовок\n\n**Жирный** и _курсив_, а remind_client остаётся\n- пункт <script>\n1. первый');
  assert.match(xml, /<w:pStyle w:val="Title"\/>/);
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Жирный/);
  assert.match(xml, /<w:i\/><\/w:rPr><w:t xml:space="preserve">курсив/);
  assert.match(xml, /remind_client/);
  assert.match(xml, /&lt;script&gt;/);
  const file = markdownToDocx('# Т\n\nТекст', 'Т');
  assert.equal(file.readUInt32LE(0), 0x04034b50);
  // Read the document entry back out of the zip: the local header says where its data starts.
  const nameLength = file.readUInt16LE(26);
  const size = file.readUInt32LE(18);
  const first = file.subarray(30, 30 + nameLength).toString();
  assert.equal(first, '[Content_Types].xml');
  assert.match(inflateRawSync(file.subarray(30 + nameLength, 30 + nameLength + size)).toString(), /wordprocessingml\.document\.main/);
  assert.equal(slugFile('Концепция продукта «Студия»'), 'концепция-продукта-студия');

  const imported = importConceptText('Онлайн-запись в студию.\n\nДальше подробности.\nЕщё строка.');
  assert.equal(imported.pitch, 'Онлайн-запись в студию.');
  assert.equal(imported.notes, 'Дальше подробности. Ещё строка.');
  assert.deepEqual(conceptChanges(imported, { ...imported, glossary: [{ key: 'g1', term: 'ТЗ', meaning: 'm' }] }), ['В словарь добавлено «ТЗ».']);
});

describe('product concept (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM stage_approvals LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('is drafted, shown as a document, accepted and downloaded as Markdown and Word', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));
    const email = `concept-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Студия', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;
    const row = async (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });
    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'goal', (await row('goal')).currentVersionId!);
    await journey.skip(owner.id, projectId, 'idea', 'Студия работает три года');
    const process = { ...templateProcess('booking', null), situations: situationsFor('booking').map((item) => ({ key: item.key, answer: (item.options.find((option) => option.typical) ?? item.options[0]!).value })) };
    await journey.saveDraft(owner.id, projectId, 'process', { content: process, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'process', (await row('process')).currentVersionId!);
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    assert.equal((await row('concept')).status, 'ready');

    // Before a draft the stage already shows the document from the accepted stages.
    const before = (await journey.stage(owner.id, projectId, 'concept')).data.options as unknown as { concept: { sections: Array<{ key: string; empty: string | null }>; diagrams: unknown[] } };
    assert.equal(before.concept.sections.find((section) => section.key === 'value')!.empty, 'Этап «Разбор идеи» пропущен владельцем.');
    assert.equal(before.concept.diagrams.length, 2);
    await assert.rejects(journey.conceptFile(owner.id, projectId, 'md'), /NOTHING_TO_EXPORT/);

    const drafted = await journey.generate(owner.id, projectId, 'concept', { instruction: null, saveAs: 'one_off', targetKey: null });
    assert.equal(drafted.data.provider, 'template');
    await journey.accept(owner.id, projectId, 'concept', (await row('concept')).currentVersionId!);
    assert.equal((await row('concept')).status, 'approved');

    const markdown = await journey.conceptFile(owner.id, projectId, 'md');
    assert.equal(markdown.name, 'концепция-продукта-студия.md');
    assert.match(markdown.data.toString(), /^# Концепция продукта «Студия»/);
    const word = await journey.conceptFile(owner.id, projectId, 'docx');
    assert.equal(word.data.readUInt32LE(0), 0x04034b50);
    assert.match(word.mime, /wordprocessingml/);
  });
});
