import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { emptyBrief, completenessIssues, type Brief } from './artifacts.js';
import { definitionOf, projectTypes, routeDependents, routeInputs } from './catalog.js';
import { describeChanges } from './change-summary.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { actionAvailable, defaultAction, normalizePaths, pathsChanges, pathsMarkdown, templatePaths, type CustomerPaths } from './paths.js';
import { phaseOf } from './phases.js';
import { templateProcess } from './process.js';
import { templateFeatures } from './webapp.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { reviewStage } from './stage-review.js';
import { WorktimeService } from './worktime.service.js';

const path = (value: Partial<CustomerPaths['paths'][number]> = {}) => ({
  key: 'mom', who: 'Мама с ребёнком', from: 'search' as const, wants: 'Узнать цену чистки дивана',
  steps: [{ where: 'Главная', sees: 'Кто вы и кнопка' }, { where: 'Цены', sees: 'Сколько стоит' }], action: 'message' as const,
  doubt: 'Вдруг испортят ткань', answer: 'Блок «Как мы работаем» с гарантией', ...value,
});

describe('«Путь клиента»: how visitors of a site reach the main action', () => {
  it('is a stage of every site route after the ТЗ and its pages, and the texts build on it; an application has screens instead', () => {
    for (const type of Object.values(projectTypes)) {
      if (type.key === 'web_app') { assert.ok(!type.stages.includes('paths')); continue; }
      const at = type.stages.indexOf('paths');
      assert.ok(at > type.stages.indexOf('features') && at < type.stages.indexOf('techplan'), type.key);
      assert.ok(routeInputs(type.stages, 'content').includes('paths'), type.key);
      assert.ok(!routeInputs(type.stages, 'design').includes('paths'), type.key);
    }
    assert.deepEqual(routeInputs(projectTypes.multipage.stages, 'paths'), ['goal', 'idea', 'features', 'offer', 'sitemap']);
    assert.deepEqual(routeInputs(projectTypes.booking.stages, 'paths'), ['goal', 'idea', 'features', 'offer', 'schedule']);
    assert.ok(routeDependents(projectTypes.landing.stages, 'paths').includes('content'));
    assert.equal(phaseOf('paths'), 'experience');
    assert.equal(definitionOf('paths').ai.level, 'ai_full');
    assert.ok(definitionOf('paths').optional, 'a simple site may skip it');
    // Older projects have no row for it: their route and the inputs of their texts do not change.
    const old = projectTypes.landing.stages.filter((key) => key !== 'paths' && key !== 'story');
    assert.ok(!routeInputs(old, 'content').includes('paths'));
  });

  it('keeps only known sources and actions, limits paths and steps, and tells what is missing', () => {
    const value = normalizePaths({ paths: [path({ from: 'tv' as never, action: 'fly' as never, steps: [{ where: '', sees: '' }, { where: 'Главная', sees: '' }] })] });
    assert.equal(value.paths[0]!.from, 'other');
    assert.equal(value.paths[0]!.action, null);
    assert.deepEqual(value.paths[0]!.steps, [{ where: 'Главная', sees: '' }]);
    assert.throws(() => normalizePaths({ paths: Array.from({ length: 6 }, () => path()) }), /FIELD_COUNT:paths/);
    assert.throws(() => normalizePaths({ paths: [path({ steps: Array.from({ length: 7 }, () => ({ where: 'x', sees: 'y' })) })] }), /FIELD_COUNT:paths.0.steps/);
    assert.throws(() => normalizePaths({ paths: [path({ wants: 'x'.repeat(201) })] }), /FIELD_TOO_LONG:paths.0.wants/);
    // Duplicate keys get their own.
    assert.deepEqual(normalizePaths({ paths: [path(), path()] }).paths.map((item) => item.key), ['mom', 'path-2']);
    assert.deepEqual(completenessIssues('paths', normalizePaths({ paths: [] })).map((issue) => issue.key), ['paths']);
    assert.equal(completenessIssues('paths', normalizePaths({ paths: [path({ who: '', wants: '', steps: [], action: null })] })).length, 4);
    assert.deepEqual(completenessIssues('paths', normalizePaths({ paths: [path()] })), []);
  });

  it('points out long paths, actions the site cannot take and doubts without an answer', () => {
    const codes = (value: CustomerPaths, projectType = 'landing') => reviewStage('paths', value, { projectType }).findings.map((finding) => finding.code);
    assert.deepEqual(codes({ paths: [path()] }), []);
    assert.deepEqual(codes({ paths: [path({ steps: Array.from({ length: 5 }, (_, i) => ({ where: `Шаг ${i}`, sees: '' })) })] }), ['PATH_TOO_LONG']);
    assert.deepEqual(codes({ paths: [path({ action: 'booking' })] }), ['PATH_ACTION_UNAVAILABLE']);
    assert.deepEqual(codes({ paths: [path({ action: 'booking' })] }, 'booking'), []);
    assert.deepEqual(codes({ paths: [path({ action: 'order' })] }, 'store'), []);
    assert.deepEqual(codes({ paths: [path({ answer: '' })] }), ['PATH_DOUBT_NO_ANSWER']);
    assert.deepEqual(codes({ paths: [path({ doubt: '', answer: '' })] }), ['PATH_NO_DOUBTS']);
    assert.ok(reviewStage('paths', { paths: [path({ action: 'order', answer: '' })] }, { projectType: 'landing' }).findings.every((finding) => finding.severity !== 'blocking'));
    assert.equal(actionAvailable('call', 'store'), true);
    assert.equal(defaultAction({ ...emptyBrief(), mainAction: 'call' }, 'landing'), 'call');
    assert.equal(defaultAction({ ...emptyBrief(), mainAction: 'call' }, 'booking'), 'booking');
    assert.equal(defaultAction(null, 'store'), 'order');
  });

  it('drafts without AI one path per kind of visitor, along the site pages, to the main action', () => {
    const brief: Brief = { ...emptyBrief(), businessName: 'Чистка', whatYouDo: 'Химчистка мебели', audience: 'Семьи', mainAction: 'message' };
    const idea = { segments: [{ key: 's1', name: 'Семьи с детьми', need: 'Почистить диван после ребёнка' }, { key: 's2', name: 'Арендодатели', need: 'Подготовить квартиру к жильцам' }] } as never;
    const sitemap = { pages: [{ key: 'home', path: '/', title: 'Главная', purpose: '', sections: ['hero'] }, { key: 'prices', path: '/prices', title: 'Цены', purpose: '', sections: ['services'] }] } as never;
    const drafted = templatePaths({ brief, idea, sitemap, offer: null, projectType: 'multipage' });
    assert.deepEqual(drafted.paths.map((item) => item.who), ['Семьи с детьми', 'Арендодатели']);
    assert.deepEqual(drafted.paths[0]!.steps.map((step) => step.where), ['Главная', 'Цены']);
    assert.equal(drafted.paths[0]!.action, 'message');
    assert.equal(drafted.paths[0]!.doubt, '');
    // Without the idea review: one path for the clients from the goal; a store goes through the catalog and the cart.
    const store = templatePaths({ brief, idea: null, sitemap: null, offer: null, projectType: 'store' });
    assert.equal(store.paths.length, 1);
    assert.equal(store.paths[0]!.who, 'Семьи');
    assert.deepEqual(store.paths[0]!.steps.map((step) => step.where), ['Главная', 'Каталог', 'Корзина']);
    assert.equal(store.paths[0]!.action, 'order');
    assert.deepEqual(completenessIssues('paths', store), []);
  });

  it('describes changes for notices and writes the paths into project.md', () => {
    const before: CustomerPaths = { paths: [path()] };
    const after: CustomerPaths = { paths: [path({ answer: 'Гарантия' }), path({ key: 'rent', who: 'Арендодатель' })] };
    assert.deepEqual(pathsChanges(before, after), ['Изменён путь «Мама с ребёнком»', 'Добавлен путь «Арендодатель»']);
    assert.deepEqual(pathsChanges(after, { paths: [] }), ['Убран путь «Мама с ребёнком»', 'Убран путь «Арендодатель»']);
    assert.deepEqual(describeChanges('paths', before, after), pathsChanges(before, after));
    const markdown = pathsMarkdown(before).join('\n');
    assert.match(markdown, /\*\*Мама с ребёнком\*\* \(Поиск в интернете\): Узнать цену/);
    assert.match(markdown, /Главная → Цены → Пишет в мессенджер/);
    assert.match(markdown, /Сомнение: Вдруг испортят ткань — ответ: Блок/);
  });
});

describe('«Путь клиента» (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM project_stages LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('a new landing gets the stage; its draft, options and acceptance open the next stages', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.setProvider(null);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const email = `paths-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Чистка', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
    const row = (key: string) => prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } });
    const step = async (key: string, content: unknown) => { await journey.saveDraft(owner.id, projectId, key, { content, baseVersionId: null }); await journey.accept(owner.id, projectId, key, (await row(key)).currentVersionId!); };
    await step('story', { name: 'Чистка', essence: 'Химчистка мебели на дому по заявке с телефона', audience: 'Семьи с детьми', problem: 'Мастера ищут через знакомых', story: null, materials: null });
    await step('goal', { businessName: 'Чистка', whatYouDo: 'Химчистка мебели на дому', audience: 'Семьи с детьми', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@clean', email: null, address: null, tone: 'friendly' });
    for (const key of ['idea', 'suggestions', 'concept']) await journey.skip(owner.id, projectId, key, 'Проверяем путь клиента');
    const brief = (await journey.stage(owner.id, projectId, 'goal')).data.current!.content as Brief;
    await step('process', templateProcess('landing', brief));
    await step('features', templateFeatures(brief, templateProcess('landing', brief), 'site'));
    assert.equal((await row('paths')).status, 'ready');
    const detail = (await journey.stage(owner.id, projectId, 'paths')).data;
    const options = (detail.options as { paths: { actions: Array<{ id: string }>; sources: Array<{ id: string; label: string }>; places: string[] } }).paths;
    assert.deepEqual(options.actions.map((item) => item.id), ['call', 'message', 'form', 'email', 'visit']);
    assert.equal(options.sources[0]!.label, 'Поиск в интернете');
    assert.ok(options.places.length > 0);
    assert.equal(detail.ai.templateAvailable, true);
    await journey.generate(owner.id, projectId, 'paths', { instruction: null, saveAs: 'one_off', targetKey: null });
    const draft = (await journey.stage(owner.id, projectId, 'paths')).data.current!.content as CustomerPaths;
    assert.equal(draft.paths[0]!.who, 'Семьи с детьми');
    assert.equal(draft.paths[0]!.action, 'message');
    await journey.accept(owner.id, projectId, 'paths', (await row('paths')).currentVersionId!);
    assert.equal((await row('techplan')).status, 'ready');
    // The texts are built on it.
    const content = (await journey.stage(owner.id, projectId, 'content')).data;
    assert.ok((content.inputs as Array<{ key: string }>).some((input) => input.key === 'paths'));
    const projectMd = (await journey.result(owner.id, projectId)).data.files.find((file) => file.name === 'project.md')!.content;
    assert.match(projectMd, /## Путь клиента/);
  });
});
