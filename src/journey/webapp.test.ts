import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { parse } from 'parse5';
import type { Brief } from './artifacts.js';
import { templateProcess } from './process.js';
import { projectTypes, routeInputs } from './catalog.js';
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

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

describe('web application route', () => {
  it('the route goes from functions to screens, architecture and the package', () => {
    assert.deepEqual(projectTypes.web_app.stages, ['goal', 'process', 'features', 'screens', 'techplan', 'handoff']);
    assert.deepEqual(routeInputs(projectTypes.web_app.stages, 'techplan'), ['goal', 'process', 'features', 'screens']);
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
    assert.ok(plan.limits[0]!.includes('не пишет и не запускает код'));
    assert.match(plan.api, /^openapi: 3\.1\.0/);
    assert.match(plan.api, /\/api\/auth\/login:/);
    assert.ok(plan.coverage!.every((step) => step.status !== 'built'));
    const pack = buildHandoff({ brief, process, features, screens, plan, locale: 'ru', sourceVersionIds: { features: 'v1' } });
    assert.deepEqual(pack.checks.filter((check) => check.status === 'failed'), []);
    const names = pack.files.map((file) => file.name);
    assert.ok(['README.md', 'spec.md', 'permissions.md', 'data-model.md', 'user-stories.md', 'api.yaml'].every((name) => names.includes(name)));
    assert.ok(names.filter((name) => name.startsWith('prototype/')).length === screens.screens.length);
    const spec = pack.files.find((file) => file.name === 'spec.md')!.content;
    assert.match(spec, /- \[ \] /);
    assert.match(spec, /Нужен вход через телефон/);
    assert.match(spec, /код приложения не создавался/);
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
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core));
    const email = `app-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Клин', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const versionOf = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    const accept = async (key: string) => journey.accept(owner.id, projectId, key, await versionOf(key));

    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await accept('goal');
    for (const key of ['process', 'features', 'screens']) {
      // No AI connected: the platform drafts by template.
      const drafted = await journey.generate(owner.id, projectId, key, { instruction: null, saveAs: 'one_off', targetKey: null });
      assert.equal(drafted.data.provider, 'template');
      await accept(key);
    }
    const prototype = await journey.prototype(owner.id, projectId, null);
    assert.ok(prototype.data.screens.length >= 2 && prototype.data.html.includes('Прототип'));
    await journey.saveDraft(owner.id, projectId, 'techplan', { content: { ownerNotes: null }, baseVersionId: null });
    await accept('techplan');
    const built = await journey.buildHandoff(owner.id, projectId);
    assert.deepEqual(built.data.checks.filter((check) => check.status === 'failed'), []);
    const view = await journey.stage(owner.id, projectId, 'handoff');
    assert.ok((view.data.current!.content as { files: Array<{ name: string }> }).files.some((file) => file.name === 'spec.md'));
    await assert.rejects(journey.saveDraft(owner.id, projectId, 'handoff', { content: {}, baseVersionId: built.data.versionId }), /STAGE_NOT_EDITABLE/);
    await accept('handoff');
    const result = await journey.result(owner.id, projectId);
    assert.equal(result.data.complete, true);
    assert.ok(result.data.files.some((file) => file.name === 'handoff/spec.md'));
    assert.ok(result.data.files.some((file) => file.name.startsWith('handoff/prototype/')));
  });
});
