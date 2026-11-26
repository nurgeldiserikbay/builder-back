import { fieldKind } from './webapp.js';
import { StageReviewService } from './stage-review.service.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { parse } from 'parse5';
import type { Brief } from './artifacts.js';
import { capabilitiesFor, normalizeProcess, processIssues, templateProcess } from './process.js';
import { projectTypes, routeInputs, stageDefinitions, stageFor, stageTitle } from './catalog.js';
import { guideFor, STAGE_GUIDES, STAGE_PASSPORTS } from './phases.js';
import { codeHostingCard, recommend } from '../choices/cards.js';
import { buildAppPlan, buildHandoff, featuresChanges, featuresIssues, normalizeFeatures, normalizeScreens, renderPrototype, screensIssues, templateFeatures, templateScreens } from './webapp.js';
import { auditSite } from '../quality/site-audit.js';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { StageAiService } from './stage-ai.service.js';
import { WorktimeService } from './worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RoadmapProgressService } from './roadmap-progress.service.js';
import { recordRunResults } from './plan-results.js';
import { BacklogService } from './backlog.service.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

describe('web application route', () => {
  it('the route goes from functions to screens, architecture and the package', () => {
    assert.deepEqual(projectTypes.web_app.stages, ['story', 'idea', 'process', 'suggestions', 'concept', 'features', 'screens', 'techplan', 'contracts', 'roadmap', 'testplan', 'handoff', 'launch']);
    assert.deepEqual(routeInputs(projectTypes.web_app.stages, 'techplan'), ['story', 'process', 'features', 'screens']);
    // An application made before route 1.18.0 keeps «Цель приложения»: its stages still build on it.
    assert.deepEqual(routeInputs(projectTypes.web_app.knownStages!.filter((key) => key !== 'story'), 'techplan'), ['goal', 'process', 'features', 'screens']);
    assert.deepEqual(routeInputs(projectTypes.web_app.stages, 'screens'), ['features']);
  });

  it('templates are complete and checked; broken references are dropped or reported', () => {
    const features = templateFeatures(brief, templateProcess('web_app', brief));
    assert.ok(features.roles.length >= 1 && features.features.some((feature) => feature.priority === 'must'));
    assert.deepEqual(featuresIssues(features), []);
    const screens = templateScreens(features);
    assert.deepEqual(screensIssues(screens, features), []);
    const normalized = normalizeFeatures({ roles: [{ key: 'client', name: 'Клиент' }], features: [{ key: 'f1', title: 'Заявка', roles: ['client', 'ghost'], priority: 'nope', acceptance: [] }] });
    assert.deepEqual(normalized.features[0]!.roles, ['client']);
    assert.equal(normalized.features[0]!.priority, 'should');
    assert.deepEqual(featuresIssues(normalized).map((issue) => issue.key), ['features', 'f1']);
    const linked = normalizeScreens({ screens: [{ key: 'a', title: 'A', role: 'client', blocks: [{ kind: 'zzz', title: 'x', fields: [] }], links: ['b', 'a', 'gone'] }, { key: 'b', title: 'B', role: 'client', blocks: [] }] });
    assert.deepEqual(linked.screens[0]!.links, ['b']);
    assert.equal(linked.screens[0]!.blocks[0]!.kind, 'text');
    const must = { ...normalized, features: [{ ...normalized.features[0]!, priority: 'must' as const }] };
    assert.ok(screensIssues(linked, must).some((issue) => issue.message.includes('«Заявка»')));
    assert.ok(screensIssues(linked, must).some((issue) => issue.message.includes('«B»')));
    assert.ok(featuresChanges(features, { ...features, features: features.features.slice(1) }).some((line) => line.startsWith('Убрано')));
  });

  it('an application is described in its own words: goal, process steps and the template', () => {
    // The goal form spoke of a site («посетитель», «главная кнопка сайта») and the AI picked a messenger button for a
    // repair service whose owner spoke of requests.
    const goal = stageFor('goal', 'web_app');
    const action = goal.fields!.find((field) => field.key === 'mainAction')!;
    assert.equal(goal.title, 'Цель приложения');
    assert.doesNotMatch(`${action.label} ${action.why}`, /посетител|сайт/i);
    assert.equal(action.options!.find((option) => option.value === 'form')!.label, 'Оставить заявку в приложении');
    assert.ok(goal.playbook.instructions.some((rule) => rule.includes('web application') && rule.includes('«form»')));
    assert.ok(!goal.playbook.instructions.some((rule) => rule.startsWith('Choose mainAction')));
    assert.equal(stageFor('goal', 'landing'), stageDefinitions.goal, 'a site keeps its own words');
    assert.ok(stageFor('process', 'web_app').playbook.instructions.some((rule) => rule.includes('change_status')));
    // Step choices: app actions first for an application, none of them for a site.
    const app = Object.keys(capabilitiesFor('web_app'));
    assert.deepEqual(app.slice(0, 4), ['create_request', 'assign', 'change_status', 'manage_staff']);
    assert.equal(capabilitiesFor('web_app').offline, 'Делается вне приложения, вручную');
    assert.ok(!Object.keys(capabilitiesFor('booking')).includes('assign'));
    // Without AI an application gets a request that is assigned and closed, not a site with a contact button.
    const process = templateProcess('web_app', brief);
    assert.deepEqual(processIssues(normalizeProcess(process)), []);
    assert.deepEqual(process.scenarios[0]!.steps.map((step) => step.capability), ['create_request', 'notify_owner', 'assign', 'change_status', 'view_info']);
    assert.ok(!JSON.stringify(process).includes('сайт'));
    // Found by the browser run (e2e/flow.mts): the rest of the goal, the guides, the architecture and the code hosting card
    // still spoke of a site.
    assert.equal(stageTitle('goal', 'web_app'), 'Цель приложения');
    assert.equal(stageTitle('goal', 'landing'), 'Цель сайта');
    const words = JSON.stringify({ goal: { ...stageFor('goal', 'web_app'), playbook: null }, process: { purpose: stageFor('process', 'web_app').purpose, accept: stageFor('process', 'web_app').acceptExplanation }, techplan: stageFor('techplan', 'web_app').purpose, guides: ['goal', 'process', 'techplan'].map((key) => guideFor(key as never, 'web_app')) });
    assert.doesNotMatch(words.replace(/Написать вам в мессенджер|Telegram или WhatsApp/g, ''), /сайт/i);
    assert.deepEqual(guideFor('goal', 'landing'), { ...STAGE_GUIDES.goal, passport: STAGE_PASSPORTS.goal });
    assert.equal(recommend('code_hosting', { hasSpecialists: false, projectType: 'web_app' }).optionKey, 'github');
    assert.equal(recommend('code_hosting', { hasSpecialists: false, projectType: 'landing' }).optionKey, 'archive');
    assert.doesNotMatch(`${codeHostingCard('web_app').question} ${codeHostingCard('web_app').why}`, /сайт/i);
  });

  it('the prototype is script-free, links between screens and passes the page audit', () => {
    const features = templateFeatures(brief, templateProcess('web_app', brief));
    const screens = templateScreens(features);
    const pages = renderPrototype({ brief, features, screens, locale: 'ru' });
    assert.equal(pages.length, screens.screens.length);
    const names = new Set(pages.map((page) => page.path));
    for (const page of pages) {
      assert.ok(!page.html.includes('<script'));
      const hrefs = [...page.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      assert.ok(hrefs.every((href) => names.has(href)), `${page.path}: ${hrefs.join(',')}`);
      parse(page.html);
    }
    const audit = auditSite({ pages: pages.map((page) => ({ path: `/${page.path}`, html: page.html })), imageBytes: {}, draft: true });
    // Disabled inputs are labelled, there is one h1 and the language is set; the prototype is marked noindex on purpose.
    assert.deepEqual(audit.findings.filter((finding) => ['high', 'critical'].includes(finding.severity)).map((finding) => finding.id), []);
  });

  it('the architecture and the package describe what was agreed and say who writes the code', () => {
    const process = templateProcess('web_app', brief);
    const features = templateFeatures(brief, process);
    const screens = templateScreens(features);
    const plan = buildAppPlan({ brief, process, features, screens }, 'Нужен вход через телефон');
    assert.equal(plan.kind, 'app');
    assert.ok(plan.limits[0]!.includes('Код пишет ИИ-агент по пакету'));
    assert.match(plan.api, /^openapi: 3\.1\.0/);
    assert.match(plan.api, /\/api\/auth\/login:/);
    // The app does every step that is not done by hand: the agent writes it from the package.
    assert.ok(plan.coverage!.every((step) => step.status === (step.capability === 'offline' ? 'manual' : 'built')));
    const pack = buildHandoff({ brief, process, features, screens, plan, locale: 'ru', sourceVersionIds: { features: 'v1' } });
    assert.deepEqual(pack.checks.filter((check) => check.status === 'failed'), []);
    const names = pack.files.map((file) => file.name);
    assert.ok(['README.md', 'spec.md', 'permissions.md', 'data-model.md', 'user-stories.md', 'api.yaml'].every((name) => names.includes(name)));
    assert.ok(names.filter((name) => name.startsWith('prototype/')).length === screens.screens.length);
    const spec = pack.files.find((file) => file.name === 'spec.md')!.content;
    assert.match(spec, /- \[ \] /);
    assert.match(spec, /Нужен вход через телефон/);
    assert.match(spec, /код приложения не создавался/);
    // The ER diagram has keys, foreign keys for «one» links and types guessed from field names.
    const er = pack.files.find((file) => file.name === 'data-model.md')!.content;
    assert.match(er, /uuid id PK/);
    assert.ok(plan.dataModel.some((entity) => entity.fields.some((field) => field.type !== 'текст')));
    const linked = plan.dataModel.find((entity) => entity.links.some((link) => link.kind === 'one'));
    if (linked) assert.match(er, /uuid \S+_id FK/);
  });

  it('guesses field types from their names', () => {
    const cases: Array<[string, string]> = [['Телефон', 'phone'], ['Email', 'email'], ['Почта', 'email'], ['Сумма заказа', 'money'], ['Цена', 'money'], ['Дата рождения', 'date'],
      ['Дата и время визита', 'datetime'], ['Количество', 'number'], ['Статус', 'status'], ['Фото', 'file'], ['Адрес доставки', 'address'], ['Согласие на обработку', 'boolean'], ['Комментарий', 'text']];
    for (const [name, kind] of cases) assert.equal(fieldKind(name), kind, name);
  });
});

describe('web application route (database)', async () => {
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

  it('goes through every stage without AI and gives the package in the result', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const reviews = new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime));
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), reviews);
    const email = `app-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Клин', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    const accept = async (key: string) => journey.accept(owner.id, projectId, key, await versionOf(key));

    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await accept('story');
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    for (const key of ['process', 'features', 'screens']) {
      // No AI connected: the platform drafts by template.
      const drafted = await journey.generate(owner.id, projectId, key, { instruction: null, saveAs: 'one_off', targetKey: null });
      assert.equal(drafted.data.provider, 'template');
      await accept(key);
    }
    const prototype = await journey.prototype(owner.id, projectId, null);
    assert.ok(prototype.data.screens.length >= 2 && prototype.data.html.includes('Прототип'));
    // The architecture of an app is edited: the first draft carries a design, the owner adds a record to the schema.
    const preview = (await journey.stage(owner.id, projectId, 'techplan')).data.options.techplan!.preview as unknown as { design: { schema: { entities: Array<{ key: string }> } } };
    assert.ok(preview.design.schema.entities.length > 0);
    const design = { ...preview.design, schema: { ...preview.design.schema, entities: [...preview.design.schema.entities, { key: 'review', name: 'Отзыв', fields: [{ name: 'Оценка', type: 'number', required: true }] }] } };
    await journey.saveDraft(owner.id, projectId, 'techplan', { content: { ownerNotes: null, design }, baseVersionId: null });
    const saved = (await journey.stage(owner.id, projectId, 'techplan')).data;
    assert.ok((saved.current!.content as { dataModel: Array<{ key: string }> }).dataModel.some((entity) => entity.key === 'review'));
    assert.equal((saved.options.techplan as { outdated: boolean }).outdated, false);
    await accept('techplan');
    // Contracts start from the platform's draft: modules, operations with rights and errors, built from the schema and the ТЗ.
    const contracts = (await journey.stage(owner.id, projectId, 'contracts')).data.options.contracts as unknown as { template: { operations: Array<{ path: string }> } };
    assert.ok(contracts.template.operations.some((operation) => operation.path === '/api/auth/login'));
    await journey.saveDraft(owner.id, projectId, 'contracts', { content: contracts.template, baseVersionId: null });
    const files = ((await journey.stage(owner.id, projectId, 'contracts')).data.options.contracts as unknown as { files: Array<{ name: string; content: string }> }).files;
    assert.ok(files.find((file) => file.name === 'schema.sql')!.content.includes('CREATE TABLE "review"'));
    await accept('contracts');
    // The plan starts from the platform's draft by the contracts; after acceptance its tasks are tracked.
    const roadmap = (await journey.stage(owner.id, projectId, 'roadmap')).data.options.roadmap as unknown as { template: { modules: Array<{ key: string }> } };
    assert.equal(roadmap.template.modules[0]!.key, 'setup');
    await journey.saveDraft(owner.id, projectId, 'roadmap', { content: roadmap.template, baseVersionId: null });
    await accept('roadmap');
    // Every module of the accepted plan is now its own stage after the developer package, called by the module's name.
    const planModules = (roadmap.template as unknown as { modules: Array<{ key: string; name: string }> }).modules;
    const moduleRows = await prisma!.projectStage.findMany({ where: { projectId, stageKey: { startsWith: 'm_' } }, orderBy: { position: 'asc' } });
    assert.deepEqual(moduleRows.map((row) => row.stageKey), planModules.map((module) => `m_${module.key}`));
    assert.deepEqual(moduleRows.map((row) => row.title), planModules.map((module) => module.name));
    // The test plan is not accepted yet: the module stages wait for it.
    assert.ok(moduleRows.every((row) => row.status === 'locked'));
    const map = (await journey.journey(owner.id, projectId)).data.stages.map((stage) => stage.key);
    assert.deepEqual(map.slice(map.indexOf('handoff') + 1), [...planModules.map((module) => `m_${module.key}`), 'launch']);
    const progress = new RoadmapProgressService(prisma!, core);
    const first = (await progress.view(owner.id, projectId)).data;
    assert.equal(first.progress, 0);
    assert.ok(first.criticalPath[0] === 'setup' && first.next);
    // «Готово» needs green checks; without them a task closes only with a written reason.
    await assert.rejects(progress.update(owner.id, projectId, 'setup_repo', { status: 'done' }), /TASK_NEEDS_CHECKS/);
    await assert.rejects(progress.update(owner.id, projectId, 'setup_repo', { status: 'done_with_note', note: 'ок' }), /TASK_NOTE_REQUIRED/);
    await assert.rejects(progress.update(owner.id, projectId, 'setup_db', { status: 'blocked' }), /TASK_BLOCKER_REQUIRED/);
    const after = (await progress.update(owner.id, projectId, 'setup_repo', { status: 'done_with_note', note: 'Проверил сборку руками, тестов ещё нет', assigneeUserId: owner.id, dueDate: '2026-01-05' })).data;
    const setup = after.modules.find((module) => module.key === 'setup')!;
    // Progress is by estimated hours, not by the number of tasks.
    assert.equal(setup.progress, Math.round((setup.tasks[0]!.hours / setup.hoursTotal) * 100));
    assert.equal(after.progress, Math.round((setup.tasks[0]!.hours / after.hoursTotal) * 100));
    await progress.update(owner.id, projectId, 'setup_db', { status: 'blocked', blockedBy: 'Ждём доступ к базе от владельца' });
    assert.deepEqual((await progress.view(owner.id, projectId)).data.blocked.map((task) => task.key), ['setup_db']);
    await assert.rejects(progress.update(owner.id, projectId, 'nope', { status: 'in_progress' }), /TASK_NOT_FOUND/);
    // The test plan: the platform's cases, plus one checked by hand for «setup_env», so that task can become «готова».
    const testplan = (await journey.stage(owner.id, projectId, 'testplan')).data.options.testplan as unknown as { template: { cases: Array<{ key: string; task: string | null; method: string; class: string }> } };
    for (const kind of ['normal', 'rights', 'security']) assert.ok(testplan.template.cases.some((item) => item.class === kind), kind);
    const cases = [...testplan.template.cases.filter((item) => item.task !== 'setup_env'), { key: 'env_check', title: 'Тестовая версия открывается', class: 'normal', given: 'Выкладка сделана', steps: ['Открыть адрес тестовой версии'], expected: 'Открывается экран входа', task: 'setup_env', method: 'human', blocking: true }];
    await journey.saveDraft(owner.id, projectId, 'testplan', { content: { ...testplan.template, cases }, baseVersionId: null });
    await accept('testplan');
    assert.ok((await prisma!.projectStage.findMany({ where: { projectId, stageKey: { startsWith: 'm_' } } })).every((row) => row.status === 'ready'));
    const auto = cases.find((item) => item.method === 'auto')!;
    await assert.rejects(progress.recordCase(owner.id, projectId, auto.key, { status: 'passed' }), /CASE_AUTOMATIC/);
    await assert.rejects(progress.update(owner.id, projectId, 'setup_env', { status: 'done' }), /TASK_CHECKS_NOT_PASSED/);
    await assert.rejects(progress.recordCase(owner.id, projectId, 'env_check', { status: 'failed' }), /CASE_NOTE_REQUIRED/);
    await progress.recordCase(owner.id, projectId, 'env_check', { status: 'passed' });
    const closed = (await progress.update(owner.id, projectId, 'setup_env', { status: 'done' })).data;
    assert.deepEqual(closed.modules[0]!.tasks.find((task) => task.key === 'setup_env')!.checks, { total: 1, passed: 1, failed: 0 });
    // A task whose cases are automatic waits for the test runs.
    const waiting = closed.modules.flatMap((module) => module.tasks).find((task) => task.checks.total > 0 && task.checks.passed < task.checks.total)!;
    await assert.rejects(progress.update(owner.id, projectId, waiting.key, { status: 'done' }), /TASK_CHECKS_NOT_PASSED/);
    // The platform's run of the agent's tests marks automatic cases; a task whose cases all pass becomes «готова» by itself.
    const byAuto = closed.modules.flatMap((module) => module.tasks).find((task) => task.checks.total > 0 && cases.filter((item) => item.task === task.key).every((item) => item.method === 'auto') && task.status !== 'done_with_note')!;
    const autoCases = cases.filter((item) => item.task === byAuto.key);
    const fakeTask = randomUUID();
    const run = await prisma!.$transaction((tx) => recordRunResults(tx, { projectId, agentTaskId: fakeTask, userId: owner.id, cases: { ...Object.fromEntries(autoCases.map((item) => [item.key, 'passed' as const])), env_check: 'failed', nope: 'passed' } }));
    assert.equal(run!.recorded, autoCases.length);
    const afterRun = (await progress.view(owner.id, projectId)).data.modules.flatMap((module) => module.tasks).find((task) => task.key === byAuto.key)!;
    assert.equal(afterRun.status, 'done');
    // A person's case is not touched by a run: env_check stays passed, setup_env stays done.
    assert.equal((await prisma!.planCaseResult.findFirstOrThrow({ where: { projectId, caseKey: 'env_check' } })).status, 'passed');
    // Red again: the task goes back to work.
    const again = await prisma!.$transaction((tx) => recordRunResults(tx, { projectId, agentTaskId: fakeTask, userId: owner.id, cases: { [autoCases[0]!.key]: 'failed' } }));
    assert.deepEqual(again!.tasksReopened, [byAuto.key]);
    // The owner's acceptance: a remark on a main scenario becomes a plan task; «работает» later closes it.
    const scenario = cases.find((item) => item.class === 'normal')!;
    await assert.rejects(progress.acceptScenario(owner.id, projectId, scenario.key, { verdict: 'remark' }), /ACCEPTANCE_NOTE_REQUIRED/);
    await assert.rejects(progress.acceptScenario(owner.id, projectId, cases.find((item) => item.class === 'rights')!.key, { verdict: 'works' }), /CASE_NOT_MAIN_SCENARIO/);
    const remarked = await progress.acceptScenario(owner.id, projectId, scenario.key, { verdict: 'remark', note: 'Кнопка сохранения прячется под клавиатурой' });
    assert.equal(remarked.data.readiness.openRemarks, 1);
    const fix = (await progress.view(owner.id, projectId)).data.modules.flatMap((module) => module.tasks).find((task) => task.fromCase === scenario.key)!;
    assert.match(fix.title, /^Замечание: Кнопка сохранения прячется под клавиатурой\. Сценарий: /);
    assert.equal(fix.status, 'not_started');
    await progress.update(owner.id, projectId, fix.key, { status: 'in_progress' });
    const accepted = await progress.acceptScenario(owner.id, projectId, scenario.key, { verdict: 'works' });
    assert.equal(accepted.data.readiness.openRemarks, 0);
    assert.equal((await progress.view(owner.id, projectId)).data.modules.flatMap((module) => module.tasks).find((task) => task.key === fix.key)!.status, 'done');
    const built = await journey.buildHandoff(owner.id, projectId);
    assert.deepEqual(built.data.checks.filter((check) => check.status === 'failed'), []);
    const view = await journey.stage(owner.id, projectId, 'handoff');
    assert.ok((view.data.current!.content as { files: Array<{ name: string }> }).files.some((file) => file.name === 'schema.sql'));
    assert.ok((view.data.current!.content as { files: Array<{ name: string }> }).files.some((file) => file.name === 'plan.md'));
    assert.ok((view.data.current!.content as { files: Array<{ name: string }> }).files.some((file) => file.name === 'test-plan.md'));
    assert.ok((view.data.current!.content as { files: Array<{ name: string }> }).files.some((file) => file.name === 'spec.md'));
    await assert.rejects(journey.saveDraft(owner.id, projectId, 'handoff', { content: {}, baseVersionId: built.data.versionId }), /STAGE_NOT_EDITABLE/);
    assert.ok((await journey.handoffFiles(owner.id, projectId)).data.files.some((file) => file.name === 'README.md'));
    await accept('handoff');
    // The launch: the platform's checks block until fixed or accepted in writing; the owner's items need answers.
    const launchView = (await journey.stage(owner.id, projectId, 'launch')).data;
    assert.equal((launchView.options.launch as { items: unknown[] }).items.length, 8);
    await journey.saveDraft(owner.id, projectId, 'launch', { content: { items: [{ key: 'domain', status: 'not_needed', note: 'Пока адрес хостинга' }, { key: 'backups', status: 'done', note: 'Neon, каждый день' }] }, baseVersionId: null });
    const launchVersion = await versionOf('launch');
    const launchCodes = (await journey.stage(owner.id, projectId, 'launch')).data.review!.findings.map((finding) => `${finding.severity}:${finding.code}`);
    assert.ok(launchCodes.includes('blocking:LAUNCH_NOT_DEPLOYED'), launchCodes.join());
    assert.ok(launchCodes.includes('blocking:LAUNCH_SCENARIOS_NOT_ACCEPTED'));
    assert.ok(launchCodes.includes('important:LAUNCH_ITEM_OPEN'));
    await assert.rejects(accept('launch'), /REVIEW_BLOCKING_OPEN/);
    // A deployment that answers over HTTPS on a real database clears the deployment checks.
    await prisma!.appDeployment.create({ data: { projectId, url: 'https://app.example.com', ok: true, status: 200, database: 'postgres', checkedAt: new Date(), checkedByUserId: owner.id } });
    const afterDeploy = (await journey.stage(owner.id, projectId, 'launch')).data.review!.findings;
    assert.ok(!afterDeploy.some((finding) => finding.code.startsWith('LAUNCH_NOT_DEPLOYED') || finding.code === 'LAUNCH_MEMORY_DATABASE'));
    await reviews.override(owner.id, projectId, 'launch', { versionId: launchVersion, findingIds: afterDeploy.filter((finding) => finding.severity === 'blocking').map((finding) => finding.id), reason: 'Запускаем пробно для трёх знакомых клиентов, сценарии проходим вместе с ними' });
    await accept('launch');
    // Not complete while a module is open: each module is accepted on its own stage, honestly — by cases, not by word.
    assert.equal((await journey.result(owner.id, projectId)).data.complete, false);
    const setupStage = (await journey.stage(owner.id, projectId, 'm_setup')).data;
    assert.equal(setupStage.stage.title, planModules[0]!.name);
    assert.equal(setupStage.stage.artifactType, 'module');
    const setupView = setupStage.options.module as unknown as { key: string; facts: { tasks: Array<{ key: string; status: string }> }; dependsOn: unknown[] };
    assert.equal(setupView.key, 'setup');
    assert.ok(setupView.facts.tasks.some((task) => task.key === 'setup_db' && task.status === 'blocked'));
    await journey.saveDraft(owner.id, projectId, 'm_setup', { content: { summary: 'Каркас: репозиторий, база по schema.sql, окружения' }, baseVersionId: null });
    const setupCodes = (await journey.stage(owner.id, projectId, 'm_setup')).data.review!.findings.map((finding) => `${finding.severity}:${finding.code}`);
    assert.ok(setupCodes.includes('blocking:MODULE_TASKS_OPEN'), setupCodes.join());
    assert.ok(setupCodes.includes('important:MODULE_NOT_BUILT'), setupCodes.join());
    await assert.rejects(accept('m_setup'), /REVIEW_BLOCKING_OPEN/);
    for (const row of moduleRows) {
      if (row.stageKey !== 'm_setup') await journey.saveDraft(owner.id, projectId, row.stageKey, { content: { summary: '' }, baseVersionId: null });
      const findings = (await journey.stage(owner.id, projectId, row.stageKey)).data.review!.findings;
      await reviews.override(owner.id, projectId, row.stageKey, { versionId: await versionOf(row.stageKey), findingIds: findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.id), reason: 'Модуль принимаем для пробного запуска, задачи доделаем в следующей версии' });
      await accept(row.stageKey);
    }
    const result = await journey.result(owner.id, projectId);
    assert.equal(result.data.complete, true);
    // A new plan without a module: a module stage someone worked on is set aside, not thrown away; the rest get notices.
    await journey.reopen(owner.id, projectId, 'roadmap');
    const lastModule = planModules[planModules.length - 1]!;
    await journey.saveDraft(owner.id, projectId, 'roadmap', { content: { ...roadmap.template, modules: (roadmap.template as unknown as { modules: Array<{ key: string; dependsOn: string[] }> }).modules.filter((module) => module.key !== lastModule.key).map((module) => ({ ...module, dependsOn: module.dependsOn.filter((key) => key !== lastModule.key) })) }, baseVersionId: await versionOf('roadmap') });
    const roadmapFindings = (await journey.stage(owner.id, projectId, 'roadmap')).data.review!.findings.filter((finding) => finding.severity === 'blocking');
    if (roadmapFindings.length) await reviews.override(owner.id, projectId, 'roadmap', { versionId: await versionOf('roadmap'), findingIds: roadmapFindings.map((finding) => finding.id), reason: 'Модуль убрали из первой версии, вернём позже' });
    await accept('roadmap');
    const aside = await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: `m_${lastModule.key}` } });
    assert.equal(aside.status, 'blocked');
    assert.equal(aside.reviewNote, 'MODULE_REMOVED_FROM_PLAN');
    assert.ok((await prisma!.changeNotice.count({ where: { projectId, targetStage: { stageKey: 'm_setup' }, status: 'open' } })) > 0);
    assert.ok(result.data.files.some((file) => file.name === 'handoff/spec.md'));
    assert.ok(result.data.files.some((file) => file.name.startsWith('handoff/prototype/')));

    // «Развитие»: the backlog gathers what was postponed and takes feedback; the next version reopens the ТЗ.
    const backlog = new BacklogService(prisma!, core);
    const listed = (await backlog.add(owner.id, projectId, { title: 'Клиенты просят оплату картой', source: 'feedback', priority: 'high' })).data;
    assert.ok(listed.items.some((item) => item.source === 'feedback' && item.priority === 'high'));
    // Gathering again does not duplicate.
    assert.equal((await backlog.list(owner.id, projectId)).data.items.length, listed.items.length);
    assert.equal(listed.canStartVersion, true);
    await assert.rejects(backlog.add(owner.id, projectId, { title: 'x' }), /BACKLOG_TITLE_REQUIRED/);
    const feedback = listed.items.find((item) => item.source === 'feedback')!;
    const next = (await backlog.startVersion(owner.id, projectId, { itemIds: [feedback.id] })).data;
    assert.equal(next.currentVersion, 2);
    assert.equal(next.items.find((item) => item.id === feedback.id)!.status, 'next');
    const spec = (await journey.stage(owner.id, projectId, 'features')).data;
    assert.notEqual(spec.stage.status, 'approved');
    assert.deepEqual((spec.options as { backlogNext: Array<{ title: string }> }).backlogNext.map((item) => item.title), ['Клиенты просят оплату картой']);
    await assert.rejects(backlog.startVersion(owner.id, projectId, { itemIds: [feedback.id] }), /BACKLOG_ITEM_NOT_OPEN/);
  });

  it('holds a stage on a blocking review finding until it is fixed or explained in writing', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const review = new StageReviewService(prisma!, core, stageAi);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
    const email = `review-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Ревью', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', await versionOf('story'));
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    await journey.generate(owner.id, projectId, 'process', { instruction: null, saveAs: 'one_off', targetKey: null });
    const draft = (await journey.stage(owner.id, projectId, 'process')).data.current!.content as { rules: string[] };
    // Without the consent rule the review blocks acceptance.
    await journey.saveDraft(owner.id, projectId, 'process', { content: { ...draft, rules: [] }, baseVersionId: await versionOf('process') });
    const view = await journey.stage(owner.id, projectId, 'process');
    assert.deepEqual(view.data.review!.uncoveredBlocking, ['PROCESS_PERSONAL_DATA_NO_RULE:rules']);
    // The hand-over list names the stages built on the process; an entity without fields would stop acceptance.
    assert.ok(view.data.outputs!.for.length > 0);
    assert.ok(view.data.outputs!.items.every((item) => item.level === 'recommended' || item.met));
    const withoutFields = { ...draft, rules: [], data: [...(draft as unknown as { data: unknown[] }).data, { key: 'extra', name: 'Отзыв', fields: [], links: [] }] };
    await journey.saveDraft(owner.id, projectId, 'process', { content: withoutFields, baseVersionId: await versionOf('process') });
    await assert.rejects(journey.accept(owner.id, projectId, 'process', await versionOf('process')), /STAGE_OUTPUTS_MISSING:data/);
    await journey.saveDraft(owner.id, projectId, 'process', { content: { ...draft, rules: [] }, baseVersionId: await versionOf('process') });
    assert.equal(view.data.stage.canAccept, false);
    const versionId = await versionOf('process');
    await assert.rejects(journey.accept(owner.id, projectId, 'process', versionId), /REVIEW_BLOCKING_OPEN:PROCESS_PERSONAL_DATA_NO_RULE:rules/);
    // «Let the AI fix it» needs AI; without a provider the platform says so instead of pretending.
    await assert.rejects(review.fix(owner.id, projectId, 'process', { findingIds: ['PROCESS_PERSONAL_DATA_NO_RULE:rules'] }), /AI_NOT_CONFIGURED/);
    await assert.rejects(review.fix(owner.id, projectId, 'process', { findingIds: ['NOPE:x'] }), /FINDINGS_NOT_FOUND/);
    // Only blocking findings of this version can be explained, and the reason must say something.
    await assert.rejects(review.override(owner.id, projectId, 'process', { versionId, findingIds: ['PROCESS_PERSONAL_DATA_NO_RULE:rules'], reason: 'надо' }), /REASON_TOO_SHORT/);
    await assert.rejects(review.override(owner.id, projectId, 'process', { versionId, findingIds: ['PROCESS_ACTOR_IDLE:x'], reason: 'Это не важно сейчас вообще' }), /FINDING_NOT_BLOCKING/);
    await review.override(owner.id, projectId, 'process', { versionId, findingIds: ['PROCESS_PERSONAL_DATA_NO_RULE:rules'], reason: 'Контакты храним только в WhatsApp, согласие берём там' });
    const explained = await journey.stage(owner.id, projectId, 'process');
    assert.deepEqual(explained.data.review!.uncoveredBlocking, []);
    assert.equal(explained.data.review!.overrides[0]!.reason, 'Контакты храним только в WhatsApp, согласие берём там');
    assert.equal(explained.data.review!.findings.find((finding) => finding.id === 'PROCESS_PERSONAL_DATA_NO_RULE:rules')!.overridden, true);
    assert.equal(explained.data.stage.canAccept, true);
    await journey.accept(owner.id, projectId, 'process', versionId);
    const event = await prisma!.projectEvent.findFirst({ where: { projectId, type: 'review_override' } });
    assert.deepEqual((event!.details as { findingIds: string[] }).findingIds, ['PROCESS_PERSONAL_DATA_NO_RULE:rules']);
  });

  it('the AI reviewer gives advice that never blocks, and the AI can fix it', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const requests: Array<{ schemaName: string; system: string; user: string }> = [];
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const review = new StageReviewService(prisma!, core, stageAi);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
    const email = `aireview-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'ИИ-ревью', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', await versionOf('story'));
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    await journey.generate(owner.id, projectId, 'process', { instruction: null, saveAs: 'one_off', targetKey: null });
    core.provider = {
      name: 'fake', model: 'fake-1',
      async generate(request) {
        requests.push(request);
        if (request.schemaName.startsWith('buildpath_review_')) return { findings: [
          { severity: 'important', category: 'logic', target: 'rules', where: 'Правила', message: 'Не сказано, что делать, если клиент не отвечает два дня.', fix: 'Добавьте правило повторного звонка.' },
          { severity: 'blocking', category: 'security', target: 'nowhere', where: '<b>x</b>', message: 'Нет срока хранения переписки с клиентами.', fix: 'Укажите срок.' },
          { severity: 'minor', category: 'clarity', target: null, where: '', message: 'коротко', fix: 'x' },
        ] };
        return JSON.parse(request.user).currentDraft;
      },
    };
    const result = await review.aiReview(owner.id, projectId, 'process');
    // Untrusted output is cut down: no «blocking», unknown targets dropped, too short findings skipped.
    assert.deepEqual(result.data.findings.map((finding) => [finding.id, finding.severity, finding.target]), [['AI_REVIEW:1', 'important', 'rules'], ['AI_REVIEW:2', 'minor', null]]);
    const reviewRequest = requests.find((request) => request.schemaName === 'buildpath_review_process')!;
    assert.match(reviewRequest.system, /untrusted data/);
    assert.ok(JSON.parse(reviewRequest.user).targets.includes('rules'));
    const view = await journey.stage(owner.id, projectId, 'process');
    assert.equal(view.data.review!.ai!.findings.length, 2);
    // Advice does not change the score or block acceptance.
    assert.deepEqual(view.data.review!.uncoveredBlocking, []);
    assert.equal(view.data.stage.canAccept, true);
    const history = await stageAi.aiHistory(owner.id, projectId, { stageKey: 'process', authorId: null, query: null, before: null, limit: 10 });
    assert.equal((history.data as { items: Array<{ outcome: string; text: string | null }> }).items[0]!.outcome, 'review');
    // «Let the AI fix it» works on advice too: the instruction carries the advice text.
    const fixed = await review.fix(owner.id, projectId, 'process', { findingIds: ['AI_REVIEW:1'] });
    assert.ok(fixed.data.versionNumber > 1);
    const fixRequest = requests.filter((request) => request.schemaName === 'buildpath_process').at(-1)!;
    assert.match(JSON.parse(fixRequest.user).instruction, /клиент не отвечает два дня/);
    // The advice belongs to the version it was given on; the new version shows none until asked again.
    assert.equal((await journey.stage(owner.id, projectId, 'process')).data.review!.ai, null);
  });

  it('«Изменить через ИИ» shows the proposal first and saves it only when applied', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const email = `proposal-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Предложение', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId;
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', (await versionOf('story'))!);
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    await journey.generate(owner.id, projectId, 'process', { instruction: null, saveAs: 'one_off', targetKey: null });
    const before = await versionOf('process');
    // Without AI there is nothing to propose.
    await assert.rejects(journey.proposeChange(owner.id, projectId, 'process', { instruction: 'Добавь бухгалтера', targetKey: null }), /AI_NOT_CONFIGURED/);
    core.provider = {
      name: 'fake', model: 'fake-1',
      async generate(request) {
        const draft = JSON.parse(request.user).currentDraft as { actors: Array<{ key: string; name: string; kind: string }> };
        return { ...draft, actors: [...draft.actors, { key: 'acc', name: 'Бухгалтер', kind: 'staff' }] };
      },
    };
    const proposal = (await journey.proposeChange(owner.id, projectId, 'process', { instruction: 'Добавь бухгалтера', targetKey: null })).data;
    assert.equal(await versionOf('process'), before, 'nothing is saved before applying');
    assert.deepEqual(proposal.changed, ['actors']);
    assert.ok((proposal.content as { actors: Array<{ name: string }> }).actors.some((actor) => actor.name === 'Бухгалтер'));
    // The proposal is checked like a saved version: the new participant does nothing, and the platform can remove him.
    assert.deepEqual(proposal.findings.find((finding) => finding.code === 'PROCESS_ACTOR_IDLE')?.autoFix, { kind: 'remove_actor', actor: 'acc' });
    assert.deepEqual(proposal.blockedByLocks, []);
    const applied = (await journey.applyProposal(owner.id, projectId, 'process', proposal.proposalId)).data;
    assert.equal(await versionOf('process'), applied.versionId);
    await assert.rejects(journey.applyProposal(owner.id, projectId, 'process', proposal.proposalId), /PROPOSAL_CLOSED/);
    // A proposal made before someone saved the stage is not applied over that save.
    const stale = (await journey.proposeChange(owner.id, projectId, 'process', { instruction: 'Ещё раз', targetKey: null })).data;
    const current = (await journey.stage(owner.id, projectId, 'process')).data.current!.content;
    await journey.saveDraft(owner.id, projectId, 'process', { content: { ...(current as object), rules: [...(current as { rules: string[] }).rules, 'Отвечаем в течение часа.'] }, baseVersionId: applied.versionId });
    await assert.rejects(journey.applyProposal(owner.id, projectId, 'process', stale.proposalId), /PROPOSAL_STALE/);
    // Participants protected from the AI: the preview says the AI wanted to change them and was held back.
    await journey.setLock(owner.id, projectId, 'process', 'actors', true);
    const held = (await journey.proposeChange(owner.id, projectId, 'process', { instruction: 'Добавь кассира', targetKey: null })).data;
    assert.deepEqual(held.blockedByLocks, ['actors']);
    await journey.dismissProposal(owner.id, projectId, 'process', held.proposalId);
    await journey.dismissProposal(owner.id, projectId, 'process', stale.proposalId);
    await assert.rejects(journey.dismissProposal(owner.id, projectId, 'process', stale.proposalId), /PROPOSAL_CLOSED/);
  });

  it('contracts, plan and test plan: the AI proposes, the person applies; the AI\'s cases are marked as its own', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const review = new StageReviewService(prisma!, core, stageAi);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
    const email = `eng-ai-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Инженерия', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    const accept = async (key: string) => journey.accept(owner.id, projectId, key, await versionOf(key));
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await accept('story');
    for (const key of ['idea', 'suggestions', 'concept']) await journey.skip(owner.id, projectId, key, 'Не нужно для этого проекта');
    for (const key of ['process', 'features', 'screens']) { await journey.generate(owner.id, projectId, key, { instruction: null, saveAs: 'one_off', targetKey: null }); await accept(key); }
    const preview = (await journey.stage(owner.id, projectId, 'techplan')).data.options.techplan!.preview as unknown as { design: unknown };
    await journey.saveDraft(owner.id, projectId, 'techplan', { content: { ownerNotes: null, design: preview.design }, baseVersionId: null });
    await accept('techplan');
    type Op = { key: string; roles: string[]; errors: Array<{ status: number; code: string; when: string }>; entity: string | null; action: string; method: string; path: string };
    const template = ((await journey.stage(owner.id, projectId, 'contracts')).data.options.contracts as unknown as { template: { operations: Op[] } & Record<string, unknown> }).template;
    await journey.saveDraft(owner.id, projectId, 'contracts', { content: template, baseVersionId: null });

    let answer: (draft: Record<string, unknown>) => unknown = (draft) => draft;
    const asked: string[] = [];
    core.provider = { name: 'fake', model: 'fake-1', async generate(request) { asked.push(request.schemaName); return answer(JSON.parse(request.user).currentDraft as Record<string, unknown>); } };

    // Contracts: the AI adds an edge case to an operation and widens a right the ТЗ does not give; the review says so before saving.
    const target = template.operations.find((item) => item.roles.length && item.method === 'POST')!;
    answer = (draft) => ({ ...draft, operations: (draft.operations as Op[]).map((item) => (item.key === target.key ? { ...item, errors: [...item.errors, { status: 409, code: 'SLOT_TAKEN', when: 'Это время уже занято' }], roles: [...item.roles, 'ghost_role'] } : item)) });
    const before = await versionOf('contracts');
    const proposal = (await journey.proposeChange(owner.id, projectId, 'contracts', { instruction: 'Добавь крайние случаи', targetKey: null })).data;
    assert.equal(asked.at(-1), 'buildpath_contracts');
    assert.equal(await versionOf('contracts'), before, 'nothing is saved before applying');
    const proposed = (proposal.content as { operations: Op[] }).operations.find((item) => item.key === target.key)!;
    assert.ok(proposed.errors.some((error) => error.code === 'SLOT_TAKEN'));
    assert.ok(proposal.findings.some((finding) => finding.code.startsWith('CONTRACT_') && finding.target === target.key), 'a right wider than the ТЗ is a finding');
    await journey.dismissProposal(owner.id, projectId, 'contracts', proposal.proposalId);
    answer = (draft) => ({ ...draft, operations: (draft.operations as Op[]).map((item) => (item.key === target.key ? { ...item, errors: [...item.errors, { status: 409, code: 'SLOT_TAKEN', when: 'Это время уже занято' }] } : item)) });
    const clean = (await journey.proposeChange(owner.id, projectId, 'contracts', { instruction: 'Добавь крайние случаи', targetKey: null })).data;
    await journey.applyProposal(owner.id, projectId, 'contracts', clean.proposalId);
    await accept('contracts');

    // The plan: the AI moves a task to the second release.
    type Module = { key: string; tasks: Array<{ key: string; release: number }> } & Record<string, unknown>;
    const roadmap = ((await journey.stage(owner.id, projectId, 'roadmap')).data.options.roadmap as unknown as { template: { modules: Module[] } & Record<string, unknown> }).template;
    await journey.saveDraft(owner.id, projectId, 'roadmap', { content: roadmap, baseVersionId: null });
    const moved = roadmap.modules.flatMap((module) => module.tasks).at(-1)!;
    answer = (draft) => ({ ...draft, modules: (draft.modules as Module[]).map((module) => ({ ...module, tasks: module.tasks.map((task) => (task.key === moved.key ? { ...task, release: 2 } : task)) })) });
    const plan = (await journey.proposeChange(owner.id, projectId, 'roadmap', { instruction: 'Перенеси последнюю задачу во второй выпуск', targetKey: null })).data;
    assert.equal(asked.at(-1), 'buildpath_roadmap');
    assert.equal((plan.content as { modules: Module[] }).modules.flatMap((module) => module.tasks).find((task) => task.key === moved.key)!.release, 2);
    await journey.applyProposal(owner.id, projectId, 'roadmap', plan.proposalId);
    await accept('roadmap');

    // The test plan: a case the AI adds is marked as the AI's, even if it claims otherwise; existing cases keep their author.
    type Case = { key: string; source: string; class: string } & Record<string, unknown>;
    const cases = ((await journey.stage(owner.id, projectId, 'testplan')).data.options.testplan as unknown as { template: { cases: Case[] } & Record<string, unknown> }).template;
    await journey.saveDraft(owner.id, projectId, 'testplan', { content: cases, baseVersionId: null });
    answer = (draft) => ({ ...draft, cases: [...(draft.cases as Case[]), { ...(draft.cases as Case[])[0]!, key: 'fake_booking', title: 'Ложная запись', class: 'dishonest', honest: false, source: 'platform', plain: 'Мы проверим, что ложные записи не проходят.' }] });
    const tests = (await journey.proposeChange(owner.id, projectId, 'testplan', { instruction: 'Добавь злоупотребления', targetKey: null })).data;
    assert.equal(asked.at(-1), 'buildpath_testplan');
    const all = (tests.content as { cases: Case[] }).cases;
    assert.equal(all.find((item) => item.key === 'fake_booking')!.source, 'ai');
    assert.equal(all.find((item) => item.key === cases.cases[0]!.key)!.source, cases.cases[0]!.source);
  });

  it('architecture: «Исправить» adds what the platform would draw, and the AI changes the design only after a preview', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const review = new StageReviewService(prisma!, core, stageAi);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
    const email = `arch-ai-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Архитектура', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'story', await versionOf('story'));
    for (const key of ['idea', 'suggestions', 'concept']) await journey.skip(owner.id, projectId, key, 'Не нужно для этого проекта');
    for (const key of ['process', 'features', 'screens']) {
      await journey.generate(owner.id, projectId, key, { instruction: null, saveAs: 'one_off', targetKey: null });
      await journey.accept(owner.id, projectId, key, await versionOf(key));
    }
    type Design = { schema: { entities: Array<{ key: string; name: string }>; relations: unknown[] }; components: Array<{ key: string; kind: string; name: string }>; threats: Array<{ key: string; asset: string; how: string; mitigation: string }>; decisions: unknown[]; environments: unknown[] };
    const template = ((await journey.stage(owner.id, projectId, 'techplan')).data.options.techplan!.preview as unknown as { design: Design }).design;
    // A design that lost its server and its threats: the review says so, and «Исправить» carries what to add back.
    const broken: Design = { ...template, components: template.components.filter((item) => item.kind !== 'server_api'), threats: [] };
    await journey.saveDraft(owner.id, projectId, 'techplan', { content: { ownerNotes: null, design: broken }, baseVersionId: null });
    const findings = (await journey.stage(owner.id, projectId, 'techplan')).data.review!.findings;
    const core1 = findings.find((finding) => finding.code === 'ARCH_CORE_MISSING')!;
    assert.deepEqual(core1.autoFix && { kind: core1.autoFix.kind, part: (core1.autoFix as { part: string }).part, kinds: ((core1.autoFix as { items: Array<{ kind: string }> }).items).map((item) => item.kind) }, { kind: 'arch_add', part: 'components', kinds: ['server_api'] });
    const personal = findings.find((finding) => finding.code === 'ARCH_THREATS_PERSONAL');
    if (personal) assert.ok(((personal.autoFix as { items: Array<{ asset: string; mitigation: string }> }).items).every((threat) => threat.asset === 'personal_data' && threat.mitigation));

    // The AI: it sees only what people own (notes and design), and its answer is a preview until applied.
    const requests: Array<{ schemaName: string; user: string; maxOutputTokens?: number }> = [];
    core.provider = {
      name: 'fake', model: 'fake-1',
      async generate(request) {
        requests.push(request);
        const draft = JSON.parse(request.user).currentDraft as { ownerNotes: string | null; design: Design };
        return { ownerNotes: draft.ownerNotes, design: { ...draft.design, components: [...draft.design.components, { key: 'server_api', kind: 'server_api', name: 'Сервер', note: '' }, { key: 'sms', kind: 'sms', name: 'SMS', note: 'напоминания' }, { key: 'x', kind: 'rocket', name: 'Ракета', note: '' }], threats: [{ key: 't_sms', asset: 'availability', actor: 'outsider', how: 'Шлёт тысячи запросов на SMS-код.', mitigation: 'Не больше 3 SMS в час на номер.' }] } };
      },
    };
    const before = await versionOf('techplan');
    const proposal = (await journey.proposeChange(owner.id, projectId, 'techplan', { instruction: 'Добавь SMS-напоминания', targetKey: null })).data;
    const request = requests.at(-1)!;
    assert.equal(request.schemaName, 'buildpath_techplan');
    assert.equal(request.maxOutputTokens, 12000);
    assert.deepEqual(Object.keys(JSON.parse(request.user).currentDraft).sort(), ['design', 'ownerNotes']);
    assert.equal(await versionOf('techplan'), before, 'nothing is saved before applying');
    const content = proposal.content as { design: Design; components: Array<{ title: string }> };
    // A kind outside the catalog cannot be drawn: it is dropped. The computed plan follows the proposed design.
    assert.deepEqual(content.design.components.filter((item) => ['sms', 'server_api', 'rocket'].includes(item.kind)).map((item) => item.kind).sort(), ['server_api', 'sms']);
    assert.ok(content.components.some((item) => item.title === 'SMS'));
    assert.ok(!proposal.findings.some((finding) => finding.code === 'ARCH_CORE_MISSING'));
    const applied = (await journey.applyProposal(owner.id, projectId, 'techplan', proposal.proposalId)).data;
    const saved = (await journey.stage(owner.id, projectId, 'techplan')).data;
    assert.equal(saved.current!.id, applied.versionId);
    assert.equal((saved.options.techplan as { outdated: boolean }).outdated, false, 'the saved plan is the one the platform computes from that design');
    // «Let the AI fix it» works on architecture findings too.
    const open = saved.review!.findings.find((finding) => !finding.ownerDecides);
    if (open) assert.ok((await review.fix(owner.id, projectId, 'techplan', { findingIds: [open.id] })).data.versionNumber > applied.versionNumber);
  });
});
