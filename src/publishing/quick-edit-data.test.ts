import { StageReviewService } from '../journey/stage-review.service.js';
import 'dotenv/config';
import { templateFeatures } from '../journey/webapp.js';
import { situationsFor } from '../journey/situations.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { JourneyService } from '../journey/journey.service.js';
import { ChangeNoticesService } from '../journey/change-notices.service.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { PublishingService } from './publishing.service.js';
import { QuickEditService } from './quick-edit.service.js';
import { checkHoursEdits, checkProductEdits } from './quick-edit.js';
import { templateContent, type Brief, type Offer } from '../journey/artifacts.js';
import { templateProcess } from '../journey/process.js';
import { templateCatalog } from '../journey/products.js';
import { templateSchedule, type Schedule } from '../journey/schedule.js';
import { ProjectsService } from '../projects/projects.service.js';

const offer: Offer = { services: [{ name: 'Торт «Наполеон»', description: 'Слоёный, на заказ', price: '9000' }, { name: 'Эклеры', description: 'Набор из 6 штук', price: '3500' }], hours: 'Пн–Сб, 10:00–19:00' };

describe('quick edit rules: prices, stock and working hours', () => {
  it('changes only price and stock of products that exist', () => {
    const catalog = templateCatalog(offer);
    const ok = checkProductEdits({ products: [{ key: 'p1', price: 9500, available: true }, { key: 'p2', price: 3500, available: false }] }, catalog);
    assert.ok(ok.ok);
    assert.deepEqual(ok.changes.map((change) => [change.key, change.field, change.before, change.after]), [['p1', 'price', 9000, 9500], ['p2', 'available', true, false]]);
    assert.equal(ok.catalog.products[0]!.name, 'Торт «Наполеон»');
    assert.deepEqual(checkProductEdits({ products: [{ key: 'p9', price: 1, available: true }] }, catalog), { ok: false, code: 'QUICK_EDIT_PRODUCT_UNKNOWN' });
    assert.deepEqual(checkProductEdits({ products: [{ key: 'p1', price: 1.5, available: true }] }, catalog), { ok: false, code: 'QUICK_EDIT_PRODUCT_PRICE_INVALID:p1' });
    assert.deepEqual(checkProductEdits({ products: [{ key: 'p1', price: 10, available: true, name: 'Новое имя' }] }, catalog), { ok: false, code: 'QUICK_EDIT_PRODUCTS_INVALID' });
    assert.deepEqual(checkProductEdits({ products: [{ key: 'p1', price: 1, available: true }, { key: 'p1', price: 2, available: true }] }, catalog), { ok: false, code: 'QUICK_EDIT_PRODUCT_UNKNOWN' });
  });

  it('changes only the week of masters that exist; a day off is null', () => {
    const schedule = templateSchedule(offer);
    const week = [...schedule.masters[0]!.week];
    week[5] = null; week[6] = { from: '11:00', to: '16:00' };
    const ok = checkHoursEdits({ masters: [{ key: 'm1', week }] }, schedule);
    assert.ok(ok.ok);
    assert.deepEqual(ok.changes.map((change) => [change.day, change.after]), [[5, null], [6, { from: '11:00', to: '16:00' }]]);
    assert.deepEqual(checkHoursEdits({ masters: [{ key: 'm1', week: week.slice(0, 6) }] }, schedule), { ok: false, code: 'QUICK_EDIT_HOURS_INVALID:m1' });
    const backwards = [...week]; backwards[0] = { from: '19:00', to: '10:00' };
    assert.deepEqual(checkHoursEdits({ masters: [{ key: 'm1', week: backwards }] }, schedule), { ok: false, code: 'QUICK_EDIT_HOURS_INVALID:m1' });
    assert.deepEqual(checkHoursEdits({ masters: [{ key: 'm9', week }] }, schedule), { ok: false, code: 'QUICK_EDIT_MASTER_UNKNOWN' });
  });
});

describe('quick edit of prices and hours (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM site_publications LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.sitePublication.deleteMany({ where: { project: { ownerUserId: { in: users } } } });
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  async function publishedProject(projectType: 'store' | 'booking') {
    process.env.BROWSER_CHECK_WORKER = 'external';
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const publishing = new PublishingService(prisma!, billing);
    const email = `qd-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Кондитерская', startMode: 'build', locale: 'ru', projectType } as never)).data.id;
    const brief: Brief = { businessName: 'Кондитерская Зерно', whatYouDo: 'Печём торты и эклеры на заказ каждый день', audience: 'Соседи и офисы', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@zerno', email: null, address: null, tone: 'friendly' };
    const version = async (stageKey: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey } })).currentVersionId!;
    const step = async (stageKey: string, content: unknown) => { await journey.saveDraft(owner.id, projectId, stageKey, { content, baseVersionId: null }); await journey.accept(owner.id, projectId, stageKey, await version(stageKey)); };
    await step('goal', brief);
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    // The owner answers the questions the platform asks about the business (the typical answer each time).
    await step('process', { ...templateProcess(projectType, brief), situations: situationsFor(projectType).map((item) => ({ key: item.key, answer: item.options.find((option) => option.typical)!.value })) });
    await step('features', templateFeatures(brief, templateProcess(projectType, brief), 'site'));
    if (projectType === 'store') await step('products', templateCatalog(offer));
    else { await step('offer', offer); await step('schedule', templateSchedule(offer)); }
    await step('techplan', { ownerNotes: null });
    const content = templateContent(brief, null);
    await step('content', { ...content, sections: content.sections.filter((section) => section.type !== 'benefits') });
    await step('design', { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' });
    const built = await journey.build(owner.id, projectId);
    assert.equal(built.data.quality.status, 'passed', JSON.stringify(built.data.quality.findings.filter((finding) => finding.blocking)));
    await journey.accept(owner.id, projectId, 'build', built.data.versionId);
    await publishing.publish(owner.id, projectId, { slug: `qd-${randomUUID().slice(0, 8)}`, confirm: true });
    return { owner, projectId, quick: new QuickEditService(prisma!, journey, publishing), journey, version, publishing };
  }

  it('store: new prices and stock reach the live site; the plan is answered «no change»', { skip }, async () => {
    const { owner, projectId, quick } = await publishedProject('store');
    const status = (await quick.status(owner.id, projectId)).data;
    assert.deepEqual(status.products?.map((product) => [product.key, product.price, product.available]), [['p1', 9000, true], ['p2', 3500, true]]);
    assert.equal(status.schedule, null);
    await assert.rejects(quick.products(owner.id, projectId, { products: [{ key: 'p1', price: 9000, available: true }] }), /QUICK_EDIT_NO_CHANGES/);
    const done = (await quick.products(owner.id, projectId, { products: [{ key: 'p1', price: 9900, available: true }, { key: 'p2', price: 3500, available: false }] })).data;
    assert.equal(done.published.products.length, 2);
    const stages = await prisma!.projectStage.findMany({ where: { projectId }, select: { stageKey: true, status: true } });
    assert.ok(stages.every((stage) => stage.status === 'approved' || (['idea', 'suggestions', 'concept'].includes(stage.stageKey) && stage.status === 'skipped')), JSON.stringify(stages));
    const answered = await prisma!.changeNotice.findMany({ where: { projectId, status: { not: 'open' } }, select: { status: true, targetStage: { select: { stageKey: true } } } });
    assert.ok(answered.some((notice) => notice.targetStage.stageKey === 'techplan'));
    const live = await prisma!.sitePublication.findFirstOrThrow({ where: { projectId }, select: { buildVersionId: true } });
    const site = (await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: live.buildVersionId! }, select: { content: true } })).content as { html: string };
    assert.match(site.html, /9\s?900/);
    assert.match(site.html, /Нет в наличии: Эклеры/);
    assert.equal((await prisma!.projectEvent.count({ where: { projectId, type: 'quick_edit_products' } })), 1);
  });

  it('booking: new working hours reach the live site', { skip }, async () => {
    const { owner, projectId, quick, version } = await publishedProject('booking');
    const status = (await quick.status(owner.id, projectId)).data;
    assert.equal(status.products, null);
    const week = [...status.schedule!.masters[0]!.week];
    week[6] = { from: '11:00', to: '15:00' };
    await quick.hours(owner.id, projectId, { masters: [{ key: 'm1', week }] });
    const schedule = (await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: await version('schedule') }, select: { content: true } })).content as unknown as Schedule;
    assert.deepEqual(schedule.masters[0]!.week[6], { from: '11:00', to: '15:00' });
    const stages = await prisma!.projectStage.findMany({ where: { projectId }, select: { stageKey: true, status: true } });
    assert.ok(stages.every((stage) => stage.status === 'approved' || (['idea', 'suggestions', 'concept'].includes(stage.stageKey) && stage.status === 'skipped')), JSON.stringify(stages));
    // Products are not part of this route.
    await assert.rejects(quick.products(owner.id, projectId, { products: [{ key: 'p1', price: 1, available: true }] }), /QUICK_EDIT_TARGET_INVALID/);
  });

  it('launch readiness and product versions: a test request is sent once a minute; a republish becomes version 2 with its changes', { skip }, async () => {
    const { owner, projectId, quick, publishing } = await publishedProject('store');
    const ready = (await publishing.readiness(owner.id, projectId)).data;
    const byKey = new Map(ready.checks.map((check) => [check.key, check]));
    assert.equal(byKey.get('build')?.status, 'ok');
    assert.equal(byKey.get('contacts')?.status, 'ok');
    assert.equal(byKey.get('situations')?.status, 'ok');
    assert.ok(byKey.has('spec') && !byKey.has('cancellation') && !ready.blocking);
    assert.equal(byKey.get('requests')?.status, 'warn');
    const tested = (await publishing.testLead(owner.id, projectId)).data;
    assert.ok(tested.lastTestAt);
    await assert.rejects(publishing.testLead(owner.id, projectId), /TEST_LEAD_TOO_OFTEN/);

    const first = (await publishing.history(owner.id, projectId)).data.versions;
    assert.equal(first.length, 1);
    assert.equal(first[0]!.productVersion, 1);
    assert.ok(first[0]!.stages?.some((stage) => stage.key === 'features' && stage.versionNumber === 1));
    assert.equal(first[0]!.changes, null);
    await quick.products(owner.id, projectId, { products: [{ key: 'p1', price: 9900, available: true }, { key: 'p2', price: 3500, available: true }] });
    const versions = (await publishing.history(owner.id, projectId)).data.versions;
    const latest = versions.find((version) => version.live)!;
    assert.equal(latest.productVersion, 2);
    assert.ok(latest.changes?.some((change) => change.key === 'products' && change.from === 1 && change.to === 2), JSON.stringify(latest.changes));
  });
});

