import 'dotenv/config';
import { after, describe, it, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import assert from 'node:assert/strict';
import { en } from '../i18n/en.js';
import { projectTypes, routeInputs, stageDefinitions } from './catalog.js';
import { ideaChanges, ideaIssues, ideaMarkdown, importIdeaText, normalizeIdea, templateIdea } from './idea.js';
import { reviewStage } from './stage-review.js';
import { stageOutputs } from './stage-outputs.js';
import { STAGE_PASSPORTS } from './phases.js';

const idea = () => normalizeIdea({
  problem: 'Мастера на дом ищут через знакомых и ждут ответа часами.',
  segments: [{ name: 'Жители Астаны с поломкой техники', need: 'Быстро вызвать мастера' }, { name: 'Мастера', need: '' }],
  value: 'Заявка за минуту и статус онлайн.',
  alternatives: [{ name: 'Звонок знакомому', how: 'долго', source: 'owner', confirmed: false }, { name: 'Профи.ру', how: '', source: 'ai', confirmed: false }],
  revenue: '',
  risks: [{ text: 'Мастера не захотят отмечать заявки', impact: 'high', decision: 'open' }, { text: 'Мало заявок зимой', impact: 'low' }],
  metrics: [{ text: '50 заявок в месяц через полгода' }, { text: 'Клиенты довольны' }],
  constraints: { deadline: 'к марту', budget: '', legal: '', dataLocation: 'Казахстан' },
});

test('a new project of every type starts with the idea in own words, then the idea review, then the process built on both', () => {
  for (const type of Object.values(projectTypes)) {
    // Sites keep «Цель сайта» right after the idea: buttons, contacts and tone; an application has no such stage.
    const start = type.key === 'web_app' ? ['story', 'idea', 'process'] : ['story', 'goal', 'idea', 'process'];
    assert.deepEqual(type.stages.slice(0, start.length), start, type.key);
    assert.deepEqual(routeInputs(type.stages, 'process'), type.key === 'web_app' ? ['story', 'idea'] : ['goal', 'idea'], type.key);
  }
  // A project made before the stage existed has no idea review: its process still depends on the goal alone.
  assert.deepEqual(routeInputs(['goal', 'process', 'features'], 'process'), ['goal']);
  assert.equal(stageDefinitions.idea.artifactType, 'idea');
  assert.ok(STAGE_PASSPORTS.idea.steps.length >= 3);
});

test('the owner\'s alternatives count as confirmed, the AI\'s wait for a tick; nothing is invented', () => {
  const value = idea();
  assert.equal(value.alternatives[0]!.confirmed, true);
  assert.equal(value.alternatives[1]!.confirmed, false);
  assert.equal(value.risks[1]!.decision, 'open');
  assert.deepEqual(templateIdea({ audience: 'Мамы в декрете' } as never).segments.map((segment) => segment.name), ['Мамы в декрете']);
  assert.equal(templateIdea(null).problem, '');
  assert.throws(() => normalizeIdea({ problem: 'x'.repeat(601) }), /FIELD_TOO_LONG:problem/);
  assert.throws(() => normalizeIdea({ metrics: [1, 2, 3, 4].map((n) => ({ text: String(n) })) }), /FIELD_TOO_MANY:metrics/);
});

test('acceptance needs the problem, for whom, the value and a goal', () => {
  assert.deepEqual(ideaIssues(normalizeIdea({})).map((issue) => issue.key), ['problem', 'segments', 'value', 'metrics']);
  assert.deepEqual(ideaIssues(idea()), []);
});

test('the review blocks a high risk without a decision and points at goals without a number and unconfirmed AI suggestions', () => {
  const findings = reviewStage('idea', idea()).findings;
  const codes = (code: string) => findings.filter((finding) => finding.code === code);
  assert.equal(codes('IDEA_RISK_HIGH_OPEN')[0]!.severity, 'blocking');
  assert.equal(codes('IDEA_RISK_HIGH_OPEN')[0]!.ownerDecides, true);
  assert.equal(codes('IDEA_METRIC_NOT_MEASURABLE').length, 1, 'only «Клиенты довольны» has no number');
  assert.equal(codes('IDEA_ALTERNATIVE_UNCONFIRMED')[0]!.target, 'alt2');
  assert.equal(codes('IDEA_NO_REVENUE').length, 1);
  assert.equal(codes('IDEA_SEGMENT_NO_NEED')[0]!.target, 'seg2');
  const settled = normalizeIdea({ ...idea(), revenue: 'Комиссия 10%', risks: [{ text: 'Мастера не захотят', impact: 'high', decision: 'mitigate', note: 'Диспетчер отмечает за них' }] });
  assert.equal(reviewStage('idea', settled).findings.filter((finding) => finding.severity === 'blocking').length, 0);
  assert.equal(reviewStage('idea', normalizeIdea({ ...settled, problem: 'Нужно приложение для мастеров' })).findings.some((finding) => finding.code === 'IDEA_PROBLEM_IS_PRODUCT'), true);
  for (const finding of findings) assert.ok(en[finding.fix] || /«/.test(finding.fix) || finding.fix.includes('{'), finding.code);
});

test('the hand-over to the process needs a problem with users and a measurable goal', () => {
  const items = stageOutputs('idea', idea());
  assert.deepEqual(items.filter((item) => item.level === 'required').map((item) => [item.key, item.met]), [['problem', true], ['metrics', true]]);
  assert.equal(stageOutputs('idea', normalizeIdea({ problem: 'x', segments: [{ name: 'y' }], metrics: [{ text: 'много клиентов' }] })).find((item) => item.key === 'metrics')!.met, false);
});

test('a written idea is laid out by its headings', () => {
  const imported = importIdeaText([
    'Хотим помочь людям быстро находить мастеров.',
    '## Для кого',
    '- Жители Астаны — нужен мастер сегодня',
    '- Мастера: ищут заказы',
    'Конкуренты: Профи.ру; звонок знакомым',
    'Монетизация: комиссия 10% с заказа',
    'Риски',
    '- мастера не будут отмечать заявки',
    'Цели: 50 заявок в месяц',
    'Бюджет: 2 млн тенге',
  ].join('\n'));
  assert.equal(imported.problem, 'Хотим помочь людям быстро находить мастеров.');
  assert.deepEqual(imported.segments.map((segment) => [segment.name, segment.need]), [['Жители Астаны', 'нужен мастер сегодня'], ['Мастера', 'ищут заказы']]);
  assert.deepEqual(imported.alternatives.map((item) => [item.name, item.source, item.confirmed]), [['Профи.ру', 'owner', true], ['звонок знакомым', 'owner', true]]);
  assert.equal(imported.revenue, 'комиссия 10% с заказа');
  assert.equal(imported.risks[0]!.text, 'мастера не будут отмечать заявки');
  assert.equal(imported.metrics[0]!.text, '50 заявок в месяц');
  assert.equal(imported.constraints.budget, '2 млн тенге');
});

test('changes are told in plain words; documents carry confirmed alternatives only', () => {
  const before = idea();
  const after = normalizeIdea({ ...before, metrics: [{ text: '80 заявок в месяц' }], segments: before.segments.slice(0, 1) });
  const lines = ideaChanges(before, after);
  assert.ok(lines.includes('Новая цель: 80 заявок в месяц'));
  assert.ok(lines.includes('Убрана группа пользователей: Мастера'));
  const text = ideaMarkdown(before).join('\n');
  assert.match(text, /Звонок знакомому/);
  assert.doesNotMatch(text, /Профи\.ру/);
});

describe('idea review (database)', async () => {
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

  it('is drafted without AI, can be skipped with a reason and reopened, and the process opens either way', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));
    const email = `idea-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Чистка', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const row = async (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Чистка', essence: 'Химчистка мебели на дому по заявке с телефона', audience: 'Семьи с детьми', problem: 'Мастера на химчистку ищут через знакомых и долго ждут', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', (await row('story')).currentVersionId!);

    // A required stage cannot be skipped, and a short reason is refused.
    await assert.rejects(journey.skip(owner.id, projectId, 'process', 'Не нужно, всё и так понятно'), /STAGE_NOT_OPTIONAL/);
    assert.equal((await journey.stage(owner.id, projectId, 'idea')).data.stage.canSkip, true);
    await journey.skip(owner.id, projectId, 'idea', 'Бизнес работает пять лет, идея проверена');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    const skipped = await row('idea');
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reviewNote, 'Бизнес работает пять лет, идея проверена');
    assert.equal((await row('process')).status, 'ready');
    assert.ok(await prisma!.projectEvent.findFirst({ where: { projectId, type: 'stage_skipped' } }));
    await assert.rejects(journey.skip(owner.id, projectId, 'idea', 'Ещё раз пропускаю этап'), /STAGE_/);

    // Coming back: the stage opens again with a template draft that copies who it is for and the problem from the idea passport.
    await journey.reopen(owner.id, projectId, 'idea');
    assert.equal((await row('idea')).status, 'ready');
    const drafted = await journey.generate(owner.id, projectId, 'idea', { instruction: null, saveAs: 'one_off', targetKey: null });
    assert.equal(drafted.data.provider, 'template');
    const draft = (await journey.stage(owner.id, projectId, 'idea')).data.current!.content as { segments: Array<{ name: string }>; problem: string };
    assert.equal(draft.segments[0]?.name, 'Семьи с детьми');
    assert.equal(draft.problem, 'Мастера на химчистку ищут через знакомых и долго ждут');
  });
});
