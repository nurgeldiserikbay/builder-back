import 'dotenv/config';
import { after, describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
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
import { normalizeArtifact } from './artifacts.js';
import { projectTypes, routeInputs, stageDefinitions } from './catalog.js';
import { normalizeProcess, templateProcess, type BusinessProcess } from './process.js';
import { normalizeIdea } from './idea.js';
import { reviewStage } from './stage-review.js';
import { situationsFor } from './situations.js';
import { stageOutputs } from './stage-outputs.js';
import { templateFeatures } from './webapp.js';
import {
  chosenForSpec, importSuggestionsText, normalizeSuggestions, suggestionsChanges, suggestionsIssues, suggestionsMarkdown,
  SUGGESTION_CATALOG, templateSuggestions, withHonestSupport, type Suggestions,
} from './suggestions.js';

const booking = (): BusinessProcess => templateProcess('booking', null);
const keys = (value: Suggestions) => value.items.map((item) => item.key);

test('the stage sits between the process and the ТЗ on every route, is optional, and the ТЗ reads it', () => {
  for (const type of Object.values(projectTypes)) {
    const at = type.stages.indexOf('suggestions');
    assert.ok(at > type.stages.indexOf('process'), type.key);
    assert.equal(type.stages[at + 1], 'concept', type.key);
    assert.equal(type.stages[at + 2], 'features', type.key);
    assert.deepEqual(routeInputs(type.stages, 'features').includes('suggestions'), true, type.key);
  }
  assert.ok(stageDefinitions.suggestions.optional);
  // Every catalog key the AI is told about exists, and every catalog entry is told about.
  const told = stageDefinitions.suggestions.playbook.instructions.at(-1)!;
  for (const entry of SUGGESTION_CATALOG) assert.ok(told.includes(entry.key), entry.key);
});

test('the draft without AI follows the process: what it lacks is suggested, what it has is not', () => {
  const process = booking();
  const has = (capability: string) => process.scenarios.some((scenario) => scenario.steps.some((step) => step.capability === capability));
  const draft = templateSuggestions('booking', null, process);
  assert.ok(draft.items.length >= 3);
  for (const item of draft.items) {
    assert.equal(item.decision, '');
    assert.ok(item.basis, item.key);
    assert.equal(item.source, 'catalog');
  }
  // Reminders are suggested only when the process does not remind already.
  assert.equal(keys(draft).includes('reminders'), has('book') && !has('remind_client'));
  // Nothing that belongs to another kind of project.
  assert.ok(!keys(draft).includes('staff_roles'));
  assert.ok(!keys(templateSuggestions('web_app', null, templateProcess('web_app', null))).includes('messenger'));
  // A goal of the idea review becomes the basis for analytics.
  const idea = normalizeIdea({ problem: 'x', segments: [{ name: 'y' }], metrics: [{ text: '30 записей в неделю' }] });
  assert.equal(templateSuggestions('landing', idea, null).items.find((item) => item.key === 'analytics')?.basis, 'Цель: 30 записей в неделю');
});

test('what the platform builds is the platform’s to say, not the AI’s', () => {
  const raw = { items: [
    { key: 'messenger', catalogKey: 'messenger', title: 'Кнопка мессенджера', support: 'code', source: 'ai' },
    { key: 'loyal', catalogKey: null, title: 'Программа лояльности', source: 'ai', support: 'site', basis: 'Цель: повторные визиты 30%' },
    { key: 'fake', catalogKey: 'no_such', title: 'Своё', source: 'catalog', support: 'site' },
  ] };
  const site = normalizeArtifact('suggestions', raw, 'landing') as Suggestions;
  assert.equal(site.items[0]!.support, 'site');
  assert.equal(site.items[0]!.source, 'catalog');
  assert.equal(site.items[1]!.support, 'not_yet');
  // An unknown catalog key is not the catalog: the item is the owner's and promises nothing.
  assert.equal(site.items[2]!.source, 'owner');
  assert.equal(site.items[2]!.catalogKey, null);
  const app = withHonestSupport(normalizeSuggestions(raw), 'web_app');
  assert.equal(app.items[0]!.support, 'code');
  assert.equal(app.items[1]!.support, 'code');
  assert.throws(() => normalizeSuggestions({ items: Array.from({ length: 21 }, (_, index) => ({ title: `П${index}` })) }), /FIELD_TOO_MANY/);
});

test('acceptance waits for a decision on each; the review warns about a growing first version and honest limits', () => {
  const value = normalizeSuggestions({ items: [
    { key: 'a', title: 'Отзывы', source: 'catalog', catalogKey: 'reviews', support: 'not_yet', decision: 'now' },
    { key: 'b', title: 'Онлайн-оплата', source: 'catalog', catalogKey: 'pay_online', support: 'account', decision: 'now' },
    { key: 'c', title: 'Отчёты', source: 'catalog', catalogKey: 'reports', decision: 'no' },
    { key: 'd', title: 'Лояльность', source: 'ai', decision: '' },
  ] });
  assert.match(suggestionsIssues(value)[0]!.message, /Осталось: 1/);
  const codes = reviewStage('suggestions', value).findings.map((finding) => finding.code);
  for (const code of ['SUGGESTION_NOT_BUILT_YET', 'SUGGESTION_NEEDS_ACCOUNT', 'SUGGESTION_NO_REASON', 'SUGGESTION_NO_BASIS']) assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('SUGGESTIONS_FIRST_VERSION_GROWS'));
  const many = normalizeSuggestions({ items: Array.from({ length: 7 }, (_, index) => ({ title: `Функция ${index}`, decision: 'now' })) });
  assert.ok(reviewStage('suggestions', many).findings.some((finding) => finding.code === 'SUGGESTIONS_FIRST_VERSION_GROWS'));
  assert.equal(stageOutputs('suggestions', value).find((item) => item.key === 'decisions')!.met, false);
  // A «now» never keeps a reason left over from «no».
  assert.equal(normalizeSuggestions({ items: [{ title: 'X', decision: 'now', reason: 'было не нужно' }] }).items[0]!.reason, '');
});

test('the choices reach the ТЗ: first version as must with a «done when», later as later, «not needed» stays out', () => {
  const value = normalizeSuggestions({ items: [
    { key: 'reminders', catalogKey: 'reminders', title: 'Напоминание клиенту о записи', value: 'Меньше клиентов забывают и не приходят.', decision: 'now', support: 'account' },
    { key: 'reviews', catalogKey: 'reviews', title: 'Отзывы клиентов', value: 'Новым клиентам проще решиться.', decision: 'later' },
    { key: 'faq', catalogKey: 'faq', title: 'Ответы на частые вопросы', decision: 'no', reason: 'Вопросов мало' },
  ] });
  assert.deepEqual(chosenForSpec(value).map((item) => [item.title, item.priority]), [['Напоминание клиенту о записи', 'must'], ['Отзывы клиентов', 'later']]);
  const spec = templateFeatures(null, booking(), 'site', value);
  const reminder = spec.features.find((feature) => feature.title === 'Напоминание клиенту о записи')!;
  assert.equal(reminder.priority, 'must');
  assert.ok(reminder.acceptance.length > 0);
  assert.match(reminder.description, /аккаунт/);
  assert.ok(!spec.features.some((feature) => feature.title === 'Ответы на частые вопросы'));
  const markdown = suggestionsMarkdown(value);
  assert.match(markdown, /### В первую версию/);
  assert.match(markdown, /Причина: Вопросов мало/);
});

test('a pasted wish list becomes undecided suggestions; changes are told in plain words', () => {
  const imported = importSuggestionsText('- Онлайн-оплата — чтобы платили заранее\n2) Бонусы за повторный визит\n\nx');
  assert.deepEqual(imported.items.map((item) => [item.title, item.value, item.source, item.decision]), [
    ['Онлайн-оплата', 'чтобы платили заранее', 'owner', ''], ['Бонусы за повторный визит', '', 'owner', ''],
  ]);
  const after = normalizeSuggestions({ items: [{ ...imported.items[0], decision: 'later' }, { key: 'new', title: 'Отзывы' }] });
  assert.deepEqual(suggestionsChanges(imported, after), ['«Онлайн-оплата»: Потом.', 'Добавлено предложение «Отзывы».', 'Убрано предложение «Бонусы за повторный визит».']);
  assert.ok(normalizeProcess(booking()));
});

describe('feature suggestions (database)', async () => {
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

  it('a draft from the process, decisions, acceptance, and the ТЗ draft carries the first-version choices', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));
    const email = `sugg-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Студия', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;
    const row = async (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });
    const brief = { businessName: 'Студия', whatYouDo: 'Маникюр', audience: 'Женщины рядом', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@studio', email: null, address: null, tone: 'friendly' };
    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'goal', (await row('goal')).currentVersionId!);
    await journey.skip(owner.id, projectId, 'idea', 'Студия работает три года');
    // The process as the owner left it: every «Вы это учли?» answered with what most businesses choose.
    const process = { ...templateProcess('booking', null), situations: situationsFor('booking').map((item) => ({ key: item.key, answer: (item.options.find((option) => option.typical) ?? item.options[0]!).value })) };
    await journey.saveDraft(owner.id, projectId, 'process', { content: process, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'process', (await row('process')).currentVersionId!);
    assert.equal((await row('suggestions')).status, 'ready');
    assert.equal((await row('features')).status, 'locked');

    const drafted = await journey.generate(owner.id, projectId, 'suggestions', { instruction: null, saveAs: 'one_off', targetKey: null });
    assert.equal(drafted.data.provider, 'template');
    const draft = (await journey.stage(owner.id, projectId, 'suggestions')).data.current!.content as Suggestions;
    assert.ok(draft.items.length >= 3);
    // Undecided: cannot be accepted yet.
    await assert.rejects(journey.accept(owner.id, projectId, 'suggestions', (await row('suggestions')).currentVersionId!), /STAGE_INCOMPLETE|INCOMPLETE/);
    const decided = { items: draft.items.map((item, index) => ({ ...item, decision: index === 0 ? 'now' : index === 1 ? 'later' : 'no', reason: index > 1 ? 'Не для нас' : '' })) };
    await journey.saveDraft(owner.id, projectId, 'suggestions', { content: decided, baseVersionId: (await row('suggestions')).currentVersionId });
    await journey.accept(owner.id, projectId, 'suggestions', (await row('suggestions')).currentVersionId!);
    assert.equal((await row('features')).status, 'ready');

    await journey.generate(owner.id, projectId, 'features', { instruction: null, saveAs: 'one_off', targetKey: null });
    const spec = (await journey.stage(owner.id, projectId, 'features')).data.current!.content as { features: Array<{ title: string; priority: string }> };
    assert.equal(spec.features.find((feature) => feature.title === draft.items[0]!.title)?.priority, 'must');
    assert.equal(spec.features.find((feature) => feature.title === draft.items[1]!.title)?.priority, 'later');
    assert.ok(!spec.features.some((feature) => feature.title === draft.items[2]!.title));
  });
});
