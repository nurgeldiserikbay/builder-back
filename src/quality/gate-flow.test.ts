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
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core));
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
});
