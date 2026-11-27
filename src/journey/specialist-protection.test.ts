import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { SpecialistsService } from './specialists.service.js';
import { StageFilesService } from '../analysis/stage-files.service.js';
import { WorktimeService } from './worktime.service.js';
import { WatermarkError, watermarkFile, watermarkLabel } from './watermark.js';
import { confidentialityHash, confidentialityPending, confidentialityView, defaultConfidentiality, readConfidentiality } from './confidentiality.js';

describe('watermarks', () => {
  const label = watermarkLabel('designer@example.com', new Date('2026-11-27T10:05:00Z'));

  it('names the address and the time in ASCII', () => {
    assert.equal(label, 'designer@example.com | 2026-11-27 10:05 UTC | BuildPath');
    assert.match(watermarkLabel('дизайнер@пример.рф', new Date(0)), /^[\x20-\x7e]+$/);
  });

  it('adds a first line to Markdown and text files and leaves other files as they are', async () => {
    const md = await watermarkFile({ kind: 'text', mime: 'text/markdown', name: 'brief.md', data: Buffer.from('# Бриф') }, label);
    assert.equal(md.marked, true);
    assert.equal(md.data.toString('utf8'), `> ${label}\n\n# Бриф`);
    const txt = await watermarkFile({ kind: 'text', mime: 'text/plain', name: 'notes.TXT', data: Buffer.from('заметки') }, label);
    assert.ok(txt.data.toString('utf8').startsWith(`[${label}]`));
    const json = Buffer.from('{"a":1}');
    assert.deepEqual(await watermarkFile({ kind: 'text', mime: 'application/json', name: 'data.json', data: json }, label), { data: json, marked: false });
    const docx = Buffer.from('PK');
    assert.equal((await watermarkFile({ kind: 'docx', mime: 'application/zip', name: 'a.docx', data: docx }, label)).marked, false);
  });

  it('draws over a photo in its own format and size', async () => {
    const plain = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366aa' } }).png().toBuffer();
    const result = await watermarkFile({ kind: 'image', mime: 'image/png', name: 'a.png', data: plain }, label);
    assert.equal(result.marked, true);
    const meta = await sharp(result.data).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 400, 300]);
    // The picture changed: the mark is drawn, not just attached.
    const before = await sharp(plain).raw().toBuffer();
    const after = await sharp(result.data).removeAlpha().raw().toBuffer();
    assert.ok(before.length === after.length && !before.equals(after));
    const jpeg = await sharp(plain).jpeg().toBuffer();
    assert.equal((await sharp((await watermarkFile({ kind: 'image', mime: 'image/jpeg', name: 'a.jpg', data: jpeg }, label)).data).metadata()).format, 'jpeg');
  });

  it('puts the mark on every page of a PDF and refuses a broken one', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]); pdf.addPage([300, 400]);
    const result = await watermarkFile({ kind: 'pdf', mime: 'application/pdf', name: 'a.pdf', data: Buffer.from(await pdf.save()) }, label);
    assert.equal(result.marked, true);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(result.data)), { mergePages: false });
    assert.equal(text.length, 2);
    assert.ok(text.every((page) => page.includes('designer@example.com')));
    await assert.rejects(watermarkFile({ kind: 'pdf', mime: 'application/pdf', name: 'b.pdf', data: Buffer.from('%PDF-1.7 broken') }, label), WatermarkError);
  });
});

describe('confidentiality terms', () => {
  it('reads the owner input: off, the template or a text', () => {
    assert.equal(readConfidentiality(null), null);
    assert.equal(readConfidentiality(false), null);
    assert.equal(readConfidentiality(true), defaultConfidentiality());
    assert.equal(readConfidentiality('  Не  рассказывать\r\n\r\n\r\nникому о проекте. '), 'Не рассказывать\n\nникому о проекте.');
    assert.throws(() => readConfidentiality('коротко'), /CONFIDENTIALITY_INVALID/);
    assert.throws(() => readConfidentiality('x'.repeat(4001)), /CONFIDENTIALITY_INVALID/);
    assert.throws(() => readConfidentiality(5), /CONFIDENTIALITY_INVALID/);
  });

  it('tells accepted, pending and changed terms apart', () => {
    const text = defaultConfidentiality();
    const hash = confidentialityHash(text);
    assert.equal(confidentialityPending({ confidentialityText: null, confidentialityAcceptedHash: null }), false);
    assert.equal(confidentialityPending({ confidentialityText: text, confidentialityAcceptedHash: null }), true);
    assert.equal(confidentialityPending({ confidentialityText: text, confidentialityAcceptedHash: hash }), false);
    const at = new Date();
    assert.deepEqual(confidentialityView({ confidentialityText: text, confidentialityAcceptedHash: hash, confidentialityAcceptedAt: at }), { text, hash, accepted: true, acceptedAt: at, changed: false });
    const changed = confidentialityView({ confidentialityText: `${text} Новое.`, confidentialityAcceptedHash: hash, confidentialityAcceptedAt: at })!;
    assert.deepEqual([changed.accepted, changed.changed, changed.acceptedAt], [false, true, null]);
  });
});

/** Against DATABASE_URL; skipped without it. */
describe('specialist protection (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT confidentiality_text, watermark FROM stage_assignments LIMIT 1`; } catch { prisma = null; }
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
    await prisma.accountPlan.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('opens the stage only after the terms are accepted, again after they change, and marks downloads', { skip }, async () => {
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const specialists = new SpecialistsService(prisma!, billing);
    const files = new StageFilesService(prisma!, core);

    const owner = await user('owner');
    const designer = await user('designer');
    await prisma!.accountPlan.create({ data: { userId: owner.id, planKey: 'business' } });
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    for (const [position, key] of ['goal', 'design'].entries()) {
      await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: key === 'design' ? 'ready' : 'locked' } });
    }

    const terms = { payKind: 'none' as const, fixedAmount: null, hourlyRate: null, hourLimit: null, weeklyHourLimit: null, revisionsIncluded: null, onlyResultTime: false };
    const invited = await specialists.invite(owner.id, project.id, 'design', { email: designer.email, role: 'lead', aiBudget: null, terms, access: { allowDownload: true, watermark: true }, confidentiality: true });
    const token = new URL(invited.data.inviteUrl).pathname.split('/').pop()!;
    const info = (await specialists.inviteInfo(token)).data;
    assert.equal(info.confidentiality?.text, defaultConfidentiality());
    assert.ok(info.cannot.some((line) => line.includes('водяного знака')));

    // Accepting without the terms, or with another text's hash, is refused.
    await assert.rejects(specialists.accept(designer.id, designer.email, token), /CONFIDENTIALITY_NOT_ACCEPTED/);
    await assert.rejects(specialists.accept(designer.id, designer.email, token, { confidentialityHash: confidentialityHash('другой текст') }), /CONFIDENTIALITY_NOT_ACCEPTED/);
    await specialists.accept(designer.id, designer.email, token, { confidentialityHash: info.confidentiality!.hash });
    await core.load(designer.id, project.id, 'read', 'design');
    const joined = await prisma!.projectEvent.findFirstOrThrow({ where: { projectId: project.id, type: 'specialist_joined' } });
    assert.equal((joined.details as { confidentialityHash: string }).confidentialityHash, info.confidentiality!.hash);

    // The owner changes the text: the stage closes, time is not counted, the new text waits for acceptance.
    const assignmentId = invited.data.assignment.id;
    const changed = await specialists.setConfidentiality(owner.id, project.id, assignmentId, { text: 'Никому не показывать макеты до запуска сайта.' });
    assert.deepEqual([changed.data.confidentiality?.accepted, changed.data.confidentiality?.changed], [false, true]);
    await assert.rejects(core.load(designer.id, project.id, 'read', 'design'), /CONFIDENTIALITY_NOT_ACCEPTED/);
    const worktime = new WorktimeService(prisma!);
    assert.equal((await worktime.heartbeat(designer.id, project.id, 'design')).data.tracking, false);
    assert.equal((await specialists.mine(designer.id)).data[0]!.confidentialityPending, true);
    const pending = (await specialists.pendingConfidentiality(designer.id, project.id)).data.pending;
    assert.deepEqual(pending.map((item) => [item.stageKey, item.changed]), [['design', true]]);
    await assert.rejects(specialists.acceptConfidentiality(designer.id, project.id, assignmentId, { hash: info.confidentiality!.hash }), /CONFIDENTIALITY_CHANGED/);
    await assert.rejects(specialists.setConfidentiality(designer.id, project.id, assignmentId, { text: null }), /PROJECT_NOT_FOUND|SPECIALISTS_FORBIDDEN/);
    await specialists.acceptConfidentiality(designer.id, project.id, assignmentId, { hash: pending[0]!.hash });
    await core.load(designer.id, project.id, 'read', 'design');
    assert.equal((await specialists.list(owner.id, project.id, 'design')).data.assignments[0]!.confidentiality?.accepted, true);
    // Turning the terms off opens the stage without anything to accept.
    await specialists.setConfidentiality(owner.id, project.id, assignmentId, { text: 'Другие условия: только для этого проекта.' });
    await specialists.setConfidentiality(owner.id, project.id, assignmentId, { text: null });
    await core.load(designer.id, project.id, 'read', 'design');

    // Downloads: the owner's text file reaches the specialist marked, and the download is written down; the owner gets it as is.
    const uploaded = (await files.upload(owner.id, project.id, 'design', { buffer: Buffer.from('# Бриф'), size: 10, originalname: 'brief.md' }, undefined)).data.createdId as string;
    const got = await files.download(designer.id, project.id, 'design', uploaded);
    assert.ok(got.data.toString('utf8').startsWith(`> ${designer.email} | `));
    assert.equal((await files.download(owner.id, project.id, 'design', uploaded)).data.toString('utf8'), '# Бриф');
    const logged = await prisma!.projectEvent.findMany({ where: { projectId: project.id, type: 'stage_file_downloaded' } });
    assert.equal(logged.length, 1);
    assert.deepEqual([(logged[0]!.details as { watermarked: boolean }).watermarked, logged[0]!.actorUserId], [true, designer.id]);
    const stage = await core.load(designer.id, project.id, 'read', 'design');
    assert.equal(core.assignmentFor(stage, 'design')?.scope.watermark, true);
  });
});
