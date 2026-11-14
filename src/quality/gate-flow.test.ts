import { StageReviewService } from '../journey/stage-review.service.js';
import 'dotenv/config';
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
import { PublishingService } from '../publishing/publishing.service.js';
import { templateContent, type Brief, type SiteArtifact } from '../journey/artifacts.js';
import { templateProcess } from '../journey/process.js';
import { ProjectsService } from '../projects/projects.service.js';
import { BrowserCheckRunner, BrowserChecksService } from './browser-checks.js';
import { defaultQualityPolicy } from '../admin/quality-profiles.service.js';
import type { BrowserCheckResult } from './browser-check.js';

/** The whole path of a one-page site through the release gate, against DATABASE_URL; skipped without a database. */
describe('release gate (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM stage_approvals LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('a built site carries its quality report; failed or missing reports block acceptance and publication', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const publishing = new PublishingService(prisma!, billing);
    const email = `gate-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const created = await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Торты', startMode: 'build', locale: 'ru', projectType: 'landing' } as never);
    const projectId = created.data.id;

    const brief: Brief = { businessName: 'Торты Айгерим', whatYouDo: 'Печём торты на заказ к праздникам', audience: 'Родители и компании', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@cakes', email: null, address: null, tone: 'friendly' };
    const stageVersion = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!;
    const step = async (key: string, content: unknown) => {
      await journey.saveDraft(owner.id, projectId, key, { content, baseVersionId: null });
      await journey.accept(owner.id, projectId, key, await stageVersion(key));
    };
    await step('goal', brief);
    await step('process', templateProcess('landing', brief));
    await step('techplan', { ownerNotes: null });
    const content = templateContent(brief, null);
    await step('content', { ...content, sections: content.sections.filter((section) => section.type !== 'benefits') });
    await step('design', { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' });

    const built = await journey.build(owner.id, projectId);
    assert.equal(built.data.quality.status, 'passed', JSON.stringify(built.data.quality.findings));
    assert.equal(built.data.quality.unmeasured.length, 3);
    const event = await prisma!.projectEvent.findFirstOrThrow({ where: { projectId, type: 'site_built' } });
    assert.equal((event.details as { quality: { status: string } }).quality.status, 'passed');

    // A build whose report failed (as a hand-edited page would) cannot be accepted.
    const version = await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: built.data.versionId } });
    const site = version.content as unknown as SiteArtifact;
    await prisma!.stageArtifactVersion.update({ where: { id: version.id }, data: { content: JSON.parse(JSON.stringify({ ...site, quality: { ...site.quality, status: 'failed' } })) } });
    await assert.rejects(journey.accept(owner.id, projectId, 'build', version.id), /QUALITY_GATE_FAILED/);
    // A build made before the gate existed is built again rather than let through.
    const { quality: _dropped, ...old } = site;
    await prisma!.stageArtifactVersion.update({ where: { id: version.id }, data: { content: JSON.parse(JSON.stringify(old)) } });
    await assert.rejects(journey.accept(owner.id, projectId, 'build', version.id), /BUILD_NOT_QUALITY_CHECKED/);
    // Even an accepted old build does not go live.
    await prisma!.projectStage.updateMany({ where: { projectId, stageKey: 'build' }, data: { status: 'approved', approvedVersionId: version.id } });
    await assert.rejects(publishing.publish(owner.id, projectId, { slug: `gate-${Date.now()}`, confirm: true }), /BUILD_NOT_QUALITY_CHECKED/);
    await prisma!.projectStage.updateMany({ where: { projectId, stageKey: 'build' }, data: { status: 'in_progress', approvedVersionId: null } });

    const rebuilt = await journey.build(owner.id, projectId);
    await journey.accept(owner.id, projectId, 'build', rebuilt.data.versionId);
    const status = await publishing.publish(owner.id, projectId, { slug: `gate-${Date.now()}`, confirm: true });
    assert.equal(status.data.publication?.status, 'live');
    assert.equal(status.data.acceptedBuild?.quality?.status, 'passed');

    // Every build queued a browser check; the worker measures it (here a fake browser), and it never holds the build.
    process.env.BROWSER_CHECK_WORKER = 'external';
    const runner = new BrowserCheckRunner(prisma!);
    const seen: Array<{ paths: string[]; locale: string }> = [];
    runner.run = async (input) => {
      seen.push({ paths: input.pages.map((page) => page.path), locale: input.locale });
      return { version: '1.0.0', tool: { lighthouse: '13.6.0', browser: 'HeadlessChrome/1' }, formFactor: 'mobile', throttling: 'simulate', measuredAt: new Date().toISOString(), skippedPages: 0,
        pages: [{ path: '/', scores: { performance: 98, accessibility: 100, 'best-practices': 96, seo: 100 }, metrics: { fcpMs: 800, lcpMs: 900, cls: 0, tbtMs: 0, speedIndexMs: 800 }, issues: [], error: null }] };
    };
    const checks = new BrowserChecksService(prisma!, core, runner);
    assert.equal(await prisma!.browserCheck.count({ where: { projectId } }), 2);
    const queued = await checks.get(owner.id, projectId, rebuilt.data.versionId);
    assert.equal(queued.data.check?.status, 'queued');
    assert.equal(queued.data.canRerun, false);
    while (await runner.processNext());
    assert.deepEqual(seen.map((item) => item.paths), [['/'], ['/']]);
    const done = await checks.get(owner.id, projectId, rebuilt.data.versionId);
    assert.equal(done.data.check?.status, 'succeeded');
    assert.equal(done.data.check?.result?.pages[0]?.scores.performance, 98);
    assert.equal(done.data.canRerun, true);
    // No browser on the server: «unavailable», not a failure of the site; it can be run again.
    runner.run = async () => { const { BrowserCheckError } = await import('./browser-check.js'); throw new BrowserCheckError('BROWSER_NOT_CONFIGURED'); };
    await checks.rerun(owner.id, projectId, rebuilt.data.versionId);
    await assert.rejects(checks.rerun(owner.id, projectId, rebuilt.data.versionId), /BROWSER_CHECK_RUNNING/);
    while (await runner.processNext());
    const unavailable = await checks.get(owner.id, projectId, rebuilt.data.versionId);
    assert.equal(unavailable.data.check?.status, 'unavailable');
    assert.equal(unavailable.data.check?.result, null);
    assert.match(unavailable.data.check?.error ?? '', /браузера/);
  });

  it('a profile with browser thresholds holds the build until the check passes them', { skip }, async () => {
    process.env.BROWSER_CHECK_WORKER = 'external';
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const publishing = new PublishingService(prisma!, billing);
    const runner = new BrowserCheckRunner(prisma!);
    const checks = new BrowserChecksService(prisma!, core, runner);
    const email = `bgate-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const staffEmail = `bgate-staff-${randomUUID()}@test.local`;
    const staff = await prisma!.staffAccount.create({ data: { email: staffEmail, emailNormalized: staffEmail, passwordHash: 'x', displayName: 'S', role: 'super_admin' } });
    const key = `fast-${randomUUID().slice(0, 8)}`;
    const policy = { ...defaultQualityPolicy(), browser: { required: true, minScores: { performance: 90, accessibility: 95, 'best-practices': null, seo: null }, maxLcpMs: 2500, maxCls: null } };
    const profile = await prisma!.qualityProfile.create({ data: { key, name: 'Быстрый', description: 'Пороги скорости', createdByStaffId: staff.id } });
    await prisma!.qualityProfileVersion.create({ data: { profileId: profile.id, version: 1, status: 'active', policy: policy as never, authoredByStaffId: staff.id, activatedAt: new Date() } });
    try {
      const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
      const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Кофейня', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
      await prisma!.project.update({ where: { id: projectId }, data: { qualityProfileKey: key } });
      const brief: Brief = { businessName: 'Кофейня Зерно', whatYouDo: 'Варим кофе и печём круассаны каждое утро', audience: 'Соседи и студенты', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@zerno', email: null, address: null, tone: 'friendly' };
      const stageVersion = async (stageKey: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey } })).currentVersionId!;
      const step = async (stageKey: string, content: unknown) => { await journey.saveDraft(owner.id, projectId, stageKey, { content, baseVersionId: null }); await journey.accept(owner.id, projectId, stageKey, await stageVersion(stageKey)); };
      await step('goal', brief);
      await step('process', templateProcess('landing', brief));
      await step('techplan', { ownerNotes: null });
      const content = templateContent(brief, null);
      await step('content', { ...content, sections: content.sections.filter((section) => section.type !== 'benefits') });
      await step('design', { palette: 'forest', font: 'modern', corners: 'rounded', heroLayout: 'centered' });

      const built = await journey.build(owner.id, projectId);
      assert.equal(built.data.quality.status, 'passed');
      assert.deepEqual(built.data.quality.profile, { key, version: 1 });
      assert.equal(built.data.quality.browserRule?.maxLcpMs, 2500);
      // Not measured yet: the build waits.
      await assert.rejects(journey.accept(owner.id, projectId, 'build', built.data.versionId), /BROWSER_CHECK_PENDING/);
      assert.equal((await checks.get(owner.id, projectId, built.data.versionId)).data.gate?.status, 'pending');

      const measured = (performance: number, lcpMs: number): BrowserCheckResult => ({ version: '1.1.0', tool: { lighthouse: '13', browser: 'HeadlessChrome/1' }, formFactor: 'mobile', throttling: 'simulate', measuredAt: new Date().toISOString(), skippedPages: 0, desktop: null,
        pages: [{ path: '/', scores: { performance, accessibility: 100, 'best-practices': 80, seo: 100 }, metrics: { fcpMs: 800, lcpMs, cls: 0, tbtMs: 0, speedIndexMs: 900 }, issues: [], error: null }] });
      runner.run = async () => measured(72, 4100);
      while (await runner.processNext());
      const failed = (await checks.get(owner.id, projectId, built.data.versionId)).data.gate!;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.reasons.length, 2); // speed score and the main block; «Надёжность» has no threshold
      assert.match(failed.reasons.join(' '), /72 из 100/);
      await assert.rejects(journey.accept(owner.id, projectId, 'build', built.data.versionId), /BROWSER_GATE_FAILED/);

      // A check that could not run is not a pass.
      runner.run = async () => { const { BrowserCheckError } = await import('./browser-check.js'); throw new BrowserCheckError('BROWSER_NOT_CONFIGURED'); };
      await checks.rerun(owner.id, projectId, built.data.versionId);
      while (await runner.processNext());
      await assert.rejects(journey.accept(owner.id, projectId, 'build', built.data.versionId), /BROWSER_CHECK_REQUIRED/);

      runner.run = async () => measured(94, 1800);
      await checks.rerun(owner.id, projectId, built.data.versionId);
      while (await runner.processNext());
      assert.equal((await checks.get(owner.id, projectId, built.data.versionId)).data.gate?.status, 'passed');
      await journey.accept(owner.id, projectId, 'build', built.data.versionId);
      // Publishing re-checks the same verdict.
      await prisma!.browserCheck.update({ where: { versionId: built.data.versionId }, data: { status: 'failed' } });
      await assert.rejects(publishing.publish(owner.id, projectId, { slug: `bgate-${Date.now()}`, confirm: true }), /BROWSER_CHECK_REQUIRED/);
      await prisma!.browserCheck.update({ where: { versionId: built.data.versionId }, data: { status: 'succeeded' } });
      assert.equal((await publishing.publish(owner.id, projectId, { slug: `bgate-${Date.now()}`, confirm: true })).data.publication?.status, 'live');
    } finally {
      await prisma!.project.updateMany({ where: { qualityProfileKey: key }, data: { qualityProfileKey: null } });
      await prisma!.qualityProfile.deleteMany({ where: { key } });
      await prisma!.staffAccount.deleteMany({ where: { id: staff.id } });
    }
  });
});
