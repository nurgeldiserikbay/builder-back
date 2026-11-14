import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { analyzeDocument, textParagraphs } from './document-analysis.js';
import { artifactText, extractRequirements, keywords, matchRequirements } from './requirements-match.js';

const brief = [
  '# Цель', 'Сайт кондитерской для приёма заказов на торты.',
  '## Функции', '- Каталог тортов с ценами и фотографиями', '- Онлайн-оплата картой Kaspi', '- Форма заказа с выбором даты доставки',
  '## Сроки', 'Запуск к 1 декабря.', '',
  'Также нужно добавить отзывы покупателей на главной.',
].join('\n');

describe('brief against stage results', () => {
  it('takes lines under requirement headings and lines that ask for something', () => {
    const items = extractRequirements(textParagraphs(brief));
    assert.deepEqual(items.map((item) => item.text), [
      '- Каталог тортов с ценами и фотографиями', '- Онлайн-оплата картой Kaspi', '- Форма заказа с выбором даты доставки', 'Также нужно добавить отзывы покупателей на главной.',
    ]);
    assert.ok(items.every((item) => item.paragraph > 0));
    assert.deepEqual(keywords('Каталога тортов, торты, ЁЛКА'), ['катало', 'торт', 'елка']);
  });

  it('names the stage with the most words of each requirement, and says honestly what is missing', () => {
    const items = extractRequirements(textParagraphs(brief));
    const stages = [
      { key: 'offer', title: 'Услуги и цены', text: artifactText({ items: [{ title: 'Торт «Наполеон»', price: 9000, note: 'Каталог тортов с ценами, фотографии каждого' }], id: randomUUID() }) },
      { key: 'content', title: 'Тексты', text: 'Форма заказа: выберите дату. Отзывы покупателей.' },
    ];
    const matched = matchRequirements(items, stages);
    assert.deepEqual(matched.map((item) => [item.status, item.stage?.key ?? null]), [['found', 'offer'], ['missing', null], ['partial', 'content'], ['found', 'content']]);
    assert.ok(matched[1]!.missingWords.includes('kaspi'));
    assert.deepEqual(matchRequirements(items, []).map((item) => item.status), ['missing', 'missing', 'missing', 'missing']);
  });

  it('keeps the requirement lines in a document report', () => {
    const report = analyzeDocument({ paragraphs: textParagraphs(brief), bytes: Buffer.from(brief), source: { kind: 'stage_file', label: 'tz.md', revision: null }, format: 'text' });
    assert.equal(report.document?.requirements?.length, 4);
  });
});

describe('brief comparison (database)', async () => {
  const { PrismaService } = await import('../database/prisma.service.js');
  let prisma: InstanceType<typeof PrismaService> | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM analysis_runs LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('compares with accepted stages only; old reports and code reports are refused', { skip }, async () => {
    const { BillingService } = await import('../billing/billing.service.js');
    const { JourneyCore } = await import('../journey/journey-core.js');
    const { CommentsService } = await import('../journey/comments.service.js');
    const { AnalysisRunner } = await import('./analysis-runner.js');
    const { AnalysisService } = await import('./analysis.service.js');
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const analysis = new AnalysisService(prisma!, core, new AnalysisRunner(prisma!), new CommentsService(prisma!, core));
    const email = `cmp-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'O' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const content = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'content', definitionVersion: '1', position: 1, status: 'approved' } });
    await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'design', definitionVersion: '1', position: 2, status: 'in_progress' } });
    const version = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: content.id, versionNumber: 1, artifactType: 'content', origin: 'owner_edit', content: { sections: [{ title: 'Каталог тортов', text: 'Цены и фотографии тортов' }] }, createdByUserId: owner.id } });
    await prisma!.projectStage.update({ where: { id: content.id }, data: { approvedVersionId: version.id } });
    const report = analyzeDocument({ paragraphs: textParagraphs(brief), bytes: Buffer.from(brief), source: { kind: 'stage_file', label: 'tz.md', revision: null }, format: 'text' });
    const run = await prisma!.analysisRun.create({ data: { projectId: project.id, status: 'succeeded', sourceKind: 'stage_file', sourceLabel: 'tz.md', profile: 'document-1.0', report: report as never, requestedByUserId: owner.id } });
    const result = (await analysis.compare(owner.id, project.id, run.id)).data;
    assert.deepEqual(result.totals, { requirements: 4, found: 1, partial: 0, missing: 3 });
    assert.deepEqual(result.comparedStages.map((stage) => stage.key), ['content']);
    assert.deepEqual(result.notAccepted.map((stage) => stage.key), ['design']);
    assert.match(result.note, /по словам/);

    const { requirements: _gone, ...oldDocument } = report.document!;
    const old = await prisma!.analysisRun.create({ data: { projectId: project.id, status: 'succeeded', sourceKind: 'stage_file', sourceLabel: 'old.md', profile: 'document-1.0', report: { ...report, document: oldDocument } as never, requestedByUserId: owner.id } });
    await assert.rejects(analysis.compare(owner.id, project.id, old.id), /COMPARE_ANALYZE_AGAIN/);
    const code = await prisma!.analysisRun.create({ data: { projectId: project.id, status: 'succeeded', sourceKind: 'stage_file', sourceLabel: 'a.zip', profile: 'code-archive-1.0', report: { ...report, type: 'code' } as never, requestedByUserId: owner.id } });
    await assert.rejects(analysis.compare(owner.id, project.id, code.id), /COMPARE_NOT_A_DOCUMENT/);
  });
});
