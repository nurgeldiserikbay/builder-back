import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { AnalysisRunner } from './analysis-runner.js';
import { AnalysisService } from './analysis.service.js';
import { StageFilesService } from './stage-files.service.js';
import { buildZip } from './zip-fixture.js';

/** Stage files and read-only analysis runs — against DATABASE_URL; skipped without it. */
describe('stage files and code analysis (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM analysis_runs LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  async function user(label: string) {
    const email = `${label}-${randomUUID()}@test.local`;
    const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: label } });
    users.push(created.id);
    return created;
  }
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('keeps files per stage with roles and scopes, and analyses an archive without changing anything', { skip }, async () => {
    process.env.UPLOAD_MALWARE_SCAN = 'disabled'; process.env.ANALYSIS_WORKER = 'external';
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const files = new StageFilesService(prisma!, core);
    const runner = new AnalysisRunner(prisma!);
    const analysis = new AnalysisService(prisma!, core, runner);

    const owner = await user('owner');
    const writer = await user('writer');
    const watcher = await user('watcher');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.createMany({ data: [
      { projectId: project.id, userId: owner.id, role: 'owner' },
      { projectId: project.id, userId: writer.id, role: 'contributor', stageKeys: ['content'] },
      { projectId: project.id, userId: watcher.id, role: 'viewer' },
    ] });
    for (const [position, key] of ['goal', 'process', 'techplan', 'content', 'design', 'build'].entries()) await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: position === 0 ? 'in_progress' : 'locked' } });

    const pdf = { buffer: Buffer.from('%PDF-1.7 brief'), size: 14, originalname: 'brief.pdf' };
    // Viewers read only; a contributor writes only on their stages; the type comes from the bytes.
    await assert.rejects(files.upload(watcher.id, project.id, 'goal', pdf, {}), /STAGE_WRITE_FORBIDDEN/);
    await assert.rejects(files.upload(writer.id, project.id, 'goal', pdf, {}), /STAGE_WRITE_FORBIDDEN/);
    await assert.rejects(files.upload(owner.id, project.id, 'goal', { ...pdf, originalname: 'brief.html' }, {}), /FILE_TYPE_NOT_SUPPORTED/);
    const uploaded = await files.upload(writer.id, project.id, 'content', pdf, { note: 'Старое ТЗ' });
    assert.equal(uploaded.data.files[0].kind, 'pdf');
    assert.equal(uploaded.data.files[0].note, 'Старое ТЗ');
    const listed = await files.list(watcher.id, project.id, 'content');
    assert.equal(listed.data.canUpload, false);
    assert.equal(listed.data.files[0].canDelete, false);
    const download = await files.download(watcher.id, project.id, 'content', uploaded.data.createdId);
    assert.equal(download.data.toString(), '%PDF-1.7 brief');
    assert.equal(download.mime, 'application/pdf');

    // An archive of the current site, analysed read-only.
    const zip = buildZip([{ name: 'site/index.html', data: '<h1>Hi</h1>' }, { name: 'site/.env', data: 'TOKEN=1' }]);
    const archive = await files.upload(owner.id, project.id, 'goal', { buffer: zip, size: zip.length, originalname: 'site.zip' }, {});
    assert.equal(archive.data.files[0].canAnalyze, true);
    // A contributor reads every stage, so the archive is among their sources; the repository is for the owner and managers.
    assert.equal((await analysis.list(writer.id, project.id)).data.sources.files.length, 1);
    await assert.rejects(analysis.create(writer.id, project.id, { source: 'repository', fileId: null, url: null, ref: null, idempotencyKey: null }), /ANALYSIS_REPOSITORY_FORBIDDEN/);
    await assert.rejects(analysis.create(owner.id, project.id, { source: 'file', fileId: randomUUID(), url: null, ref: null, idempotencyKey: null }), /FILE_NOT_FOUND/);
    await assert.rejects(analysis.create(watcher.id, project.id, { source: 'file', fileId: archive.data.createdId, url: null, ref: null, idempotencyKey: null }), /STAGE_WRITE_FORBIDDEN/);
    await assert.rejects(analysis.create(owner.id, project.id, { source: 'file', fileId: uploaded.data.createdId, url: null, ref: null, idempotencyKey: null }), /ANALYSIS_NEEDS_ZIP/);
    await assert.rejects(analysis.create(owner.id, project.id, { source: 'public_repo', fileId: null, url: 'https://gitlab.com/a/b', ref: null, idempotencyKey: null }), /REPO_URL_NOT_GITHUB/);
    await assert.rejects(analysis.create(owner.id, project.id, { source: 'repository', fileId: null, url: null, ref: null, idempotencyKey: null }), /REPO_NOT_CONNECTED/);

    const before = await prisma!.stageFile.findUniqueOrThrow({ where: { id: archive.data.createdId }, select: { sha256: true } });
    const run = await analysis.create(owner.id, project.id, { source: 'file', fileId: archive.data.createdId, url: null, ref: null, idempotencyKey: 'run-key-0001' });
    assert.equal(run.data.status, 'queued');
    const again = await analysis.create(owner.id, project.id, { source: 'file', fileId: archive.data.createdId, url: null, ref: null, idempotencyKey: 'run-key-0001' });
    assert.equal(again.data.id, run.data.id);
    await assert.rejects(analysis.export(owner.id, project.id, run.data.id, 'md'), /ANALYSIS_NOT_READY/);
    assert.equal(await runner.processNext(), true);
    const done = await analysis.get(watcher.id, project.id, run.data.id);
    assert.equal(done.data.status, 'succeeded');
    assert.equal(done.data.sourceSha256, before.sha256);
    assert.equal(done.data.report!.findings[0].code, 'ENV_FILE_COMMITTED');
    assert.deepEqual(done.data.report!.findings[0].evidence, [{ path: '.env' }]);
    // The source is untouched.
    assert.equal((await prisma!.stageFile.findUniqueOrThrow({ where: { id: archive.data.createdId }, select: { sha256: true } })).sha256, before.sha256);
    const markdown = await analysis.export(watcher.id, project.id, run.data.id, 'md');
    assert.match(markdown.body, /SHA-256: `[0-9a-f]{64}`/);
    assert.match(markdown.name, /^analysis-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/);

    // A removed archive fails its queued run with a plain reason.
    const second = await analysis.create(owner.id, project.id, { source: 'file', fileId: archive.data.createdId, url: null, ref: null, idempotencyKey: null });
    await assert.rejects(files.remove(writer.id, project.id, 'goal', archive.data.createdId), /STAGE_WRITE_FORBIDDEN/);
    await files.remove(owner.id, project.id, 'goal', archive.data.createdId);
    await runner.processNext();
    const failed = await analysis.get(owner.id, project.id, second.data.id);
    assert.equal(failed.data.status, 'failed');
    assert.equal(failed.data.errorCode, 'SOURCE_FILE_GONE');

    // Events record uploads, deletions, requests and exports.
    const events = await prisma!.projectEvent.findMany({ where: { projectId: project.id }, select: { type: true } });
    for (const type of ['stage_file_added', 'stage_file_deleted', 'analysis_run_requested', 'analysis_report_exported']) assert.ok(events.some((event) => event.type === type), type);
  });

  it('a project started as «Только анализ» takes a ZIP straight into code analysis, without stages', { skip }, async () => {
    process.env.UPLOAD_MALWARE_SCAN = 'disabled'; process.env.ANALYSIS_WORKER = 'external';
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const files = new StageFilesService(prisma!, core);
    const runner = new AnalysisRunner(prisma!);
    const analysis = new AnalysisService(prisma!, core, runner);
    const owner = await user('analyst');
    const watcher = await user('reader');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Старый сайт', startMode: 'analysis_only' } });
    await prisma!.projectMember.createMany({ data: [{ projectId: project.id, userId: owner.id, role: 'owner' }, { projectId: project.id, userId: watcher.id, role: 'viewer' }] });

    const zip = buildZip([{ name: 'README.md', data: '# Сайт' }, { name: 'index.html', data: '<h1>Hi</h1>' }]);
    const upload = { buffer: zip, size: zip.length, originalname: 'site.zip' };
    await assert.rejects(files.uploadSource(watcher.id, project.id, upload, {}), /STAGE_WRITE_FORBIDDEN/);
    await assert.rejects(files.uploadSource(owner.id, project.id, { buffer: Buffer.from('%PDF-1.7'), size: 8, originalname: 'a.pdf' }, {}), /ANALYSIS_NEEDS_ZIP/);
    const source = await files.uploadSource(owner.id, project.id, upload, {});
    const listed = await analysis.list(watcher.id, project.id);
    assert.equal(listed.data.project.analysisOnly, true);
    assert.equal(listed.data.canRun, false);
    assert.deepEqual(listed.data.sources.files.map((file) => [file.name, file.stageKey]), [['site.zip', null]]);
    const run = await analysis.create(owner.id, project.id, { source: 'file', fileId: source.data.createdId, url: null, ref: null, idempotencyKey: null });
    await runner.processNext();
    const done = await analysis.get(owner.id, project.id, run.data.id);
    assert.equal(done.data.status, 'succeeded');
    assert.deepEqual(done.data.report!.summary.stack.map((item) => item.key), ['static_html']);
    await assert.rejects(files.removeSource(watcher.id, project.id, source.data.createdId), /FILE_DELETE_FORBIDDEN/);
    await files.removeSource(owner.id, project.id, source.data.createdId);
    assert.equal((await analysis.get(owner.id, project.id, run.data.id)).data.status, 'succeeded');
  });
});
