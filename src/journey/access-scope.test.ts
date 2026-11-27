import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { SpecialistsService } from './specialists.service.js';
import { StageFilesService } from '../analysis/stage-files.service.js';
import { DEFAULT_SCOPE, editAllowed, hideableFor, parseScope, redact, scopeLines } from './access-scope.js';
import type { StageKey } from './catalog.js';

const route: StageKey[] = ['goal', 'offer', 'process', 'techplan', 'content', 'design', 'build'];
const ctx = (stageKey: StageKey, inputs: StageKey[]) => ({ route, stageKey, inputs });

describe('specialist access scope: rules', () => {
  it('validates what the owner opens, hides and allows', () => {
    assert.deepEqual(parseScope(undefined, ctx('design', ['goal'])), DEFAULT_SCOPE);
    const scope = parseScope({ extraReadStages: ['process', 'goal', 'process'], hiddenParts: ['goal.contacts', 'offer.prices'], allowDownload: true, readDays: 0 }, ctx('design', ['goal']));
    // goal is an input anyway; offer is neither an input nor opened, so hiding its prices is dropped.
    assert.deepEqual(scope, { extraReadStages: ['process'], hiddenParts: ['goal.contacts'], allowDownload: true, watermark: false, readDays: 0, editMode: 'both' });
    assert.throws(() => parseScope({ extraReadStages: ['design'] }, ctx('design', ['goal'])), /ACCESS_EXTRA_STAGES_INVALID/);
    assert.throws(() => parseScope({ extraReadStages: ['schedule'] }, ctx('design', ['goal'])), /ACCESS_EXTRA_STAGES_INVALID/);
    assert.throws(() => parseScope({ hiddenParts: ['goal.secret'] }, ctx('design', ['goal'])), /ACCESS_HIDDEN_PARTS_INVALID/);
    assert.throws(() => parseScope({ readDays: 31 }, ctx('design', ['goal'])), /ACCESS_READ_DAYS_INVALID/);
    assert.throws(() => parseScope({ other: 1 }, ctx('design', ['goal'])), /ACCESS_SCOPE_INVALID/);
    // The build renders contacts and prices; texts copy the prices.
    assert.throws(() => parseScope({ hiddenParts: ['goal.contacts'] }, ctx('build', ['goal', 'content', 'design'])), /ACCESS_HIDE_NOT_FOR_BUILD/);
    assert.throws(() => parseScope({ hiddenParts: ['offer.prices'] }, ctx('content', ['goal', 'offer'])), /ACCESS_HIDE_USED_BY_STAGE/);
    assert.deepEqual(hideableFor('content', route), ['goal.contacts']);
    assert.deepEqual(hideableFor('build', route), []);
    // A partial update keeps the rest.
    assert.deepEqual(parseScope({ allowDownload: false }, ctx('design', ['goal']), scope), { ...scope, allowDownload: false });
  });

  it('limits how the lead changes the stage: by hand, through the AI, or both', () => {
    assert.equal(parseScope({ editMode: 'ai_only' }, ctx('design', ['goal'])).editMode, 'ai_only');
    assert.throws(() => parseScope({ editMode: 'read' }, ctx('design', ['goal'])), /ACCESS_EDIT_MODE_INVALID/);
    // A build is made by the platform: there is nothing to type, so «only by hand» makes no sense there.
    assert.throws(() => parseScope({ editMode: 'manual_only' }, ctx('build', ['goal', 'content', 'design'])), /ACCESS_EDIT_MODE_INVALID/);
    assert.ok(editAllowed('both', 'manual') && editAllowed('both', 'ai'));
    assert.ok(editAllowed('ai_only', 'ai') && !editAllowed('ai_only', 'manual'));
    assert.ok(editAllowed('manual_only', 'manual') && !editAllowed('manual_only', 'ai'));
    const lines = scopeLines({ ...DEFAULT_SCOPE, editMode: 'ai_only' });
    assert.ok(lines.cannot.includes('Править этап вручную'));
  });

  it('replaces hidden parts without changing the original', () => {
    const brief = { businessName: 'Торты', phone: '+7 700 000 00 00', messenger: null, email: 'a@b.kz', address: 'Алматы' };
    const seen = redact('goal', brief, ['goal.contacts']) as typeof brief;
    assert.equal(seen.phone, 'скрыто владельцем');
    assert.equal(seen.messenger, null);
    assert.equal(seen.businessName, 'Торты');
    assert.equal(brief.phone, '+7 700 000 00 00');
    const offer = { services: [{ name: 'Торт', description: null, price: '5000 ₸' }, { name: 'Пирог', description: null, price: null }], hours: null };
    assert.deepEqual((redact('offer', offer, ['offer.prices']) as typeof offer).services.map((item) => item.price), ['скрыто владельцем', null]);
    assert.equal(redact('goal', brief, []), brief);
    const lines = scopeLines({ extraReadStages: ['process'], hiddenParts: ['goal.contacts'], allowDownload: false, watermark: true, readDays: 0, editMode: 'both' });
    assert.equal(lines.can.length, 1);
    assert.equal(lines.cannot.length, 3);
    assert.match(lines.afterAcceptance, /закроется сразу/);
  });
});

/** Against DATABASE_URL; skipped without it. */
describe('specialist access scope (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT hidden_parts FROM stage_assignments LIMIT 1`; } catch { prisma = null; }
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

  it('shows the specialist and their AI only what the owner allowed', { skip }, async () => {
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
    const stages: Record<string, string> = {};
    for (const [position, key] of ['goal', 'process', 'techplan', 'content', 'design', 'build'].entries()) {
      stages[key] = (await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: key === 'design' ? 'ready' : 'locked' } })).id;
    }
    const accepted = async (key: string, content: object) => {
      const version = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: stages[key]!, versionNumber: 1, artifactType: key, content, origin: 'owner_edit', createdByUserId: owner.id } });
      await prisma!.projectStage.update({ where: { id: stages[key] }, data: { status: 'approved', currentVersionId: version.id, approvedVersionId: version.id } });
    };
    await accepted('goal', { businessName: 'Торты', whatYouDo: 'Печём', audience: 'Родители', city: null, mainAction: 'call', phone: '+7 700 111 22 33', messenger: null, email: null, address: null, tone: null });
    await accepted('process', { roles: [], steps: [], data: [] });

    // Invite with a scope: process opened, contacts hidden, downloads off, access closes at acceptance.
    const invited = await specialists.invite(owner.id, project.id, 'design', { email: designer.email, role: 'lead', aiBudget: null, terms: { payKind: 'none', fixedAmount: null, hourlyRate: null, hourLimit: null, weeklyHourLimit: null, revisionsIncluded: null, onlyResultTime: false }, access: { extraReadStages: ['process'], hiddenParts: ['goal.contacts'], readDays: 0 } });
    const token = new URL(invited.data.inviteUrl).pathname.split('/').pop()!;
    const info = (await specialists.inviteInfo(token)).data;
    assert.ok(info.can.some((line) => line.includes('Бизнес-процесс')));
    assert.ok(info.cannot.some((line) => line.includes('контакты владельца')));
    await specialists.accept(designer.id, designer.email, token);

    const seen = await core.load(designer.id, project.id, 'read', 'design');
    const inputs = await core.viewInputs(seen, 'design');
    assert.equal((inputs.goal!.content as { phone: string }).phone, 'скрыто владельцем');
    assert.deepEqual(Object.keys(await core.extraReads(seen, 'design')), ['process']);
    // The owner still sees everything; the extra stage itself stays closed to the specialist.
    const ownerView = await core.load(owner.id, project.id, 'read', 'design');
    assert.equal((((await core.viewInputs(ownerView, 'design')).goal!.content) as { phone: string }).phone, '+7 700 111 22 33');
    await assert.rejects(core.load(designer.id, project.id, 'read', 'process'), /STAGE_NOT_FOUND/);

    // Downloads: own files always, others' only when allowed.
    const upload = async (who: string, name: string) => (await files.upload(who, project.id, 'design', { buffer: Buffer.from('заметки'), size: 14, originalname: name }, undefined)).data.createdId as string;
    const ownersFile = await upload(owner.id, 'brief.txt');
    const designersFile = await upload(designer.id, 'mine.txt');
    await assert.rejects(files.download(designer.id, project.id, 'design', ownersFile), /DOWNLOAD_NOT_ALLOWED/);
    await files.download(designer.id, project.id, 'design', designersFile);
    const listed = (await files.list(designer.id, project.id, 'design')).data.files;
    assert.deepEqual(listed.map((file) => [file.name, file.canDownload]).sort(), [['brief.txt', false], ['mine.txt', true]]);
    const assignmentId = invited.data.assignment.id;
    await specialists.updateAccess(owner.id, project.id, assignmentId, { allowDownload: true });
    await files.download(designer.id, project.id, 'design', ownersFile);
    await assert.rejects(specialists.updateAccess(designer.id, project.id, assignmentId, { allowDownload: true }), /PROJECT_NOT_FOUND|SPECIALISTS_FORBIDDEN/);

    // Showing contacts again applies at once.
    await specialists.updateAccess(owner.id, project.id, assignmentId, { hiddenParts: [] });
    const again = await core.load(designer.id, project.id, 'read', 'design');
    assert.equal(((await core.viewInputs(again, 'design')).goal!.content as { phone: string }).phone, '+7 700 111 22 33');
    const list = (await specialists.list(owner.id, project.id, 'design')).data;
    assert.deepEqual(list.accessOptions.extraStages.map((item) => item.key), ['process', 'techplan', 'content', 'build']);
    assert.equal(list.assignments[0]!.access.allowDownload, true);

    // Only through the AI: typing into the stage is refused on the server; the owner is never limited.
    await specialists.updateAccess(owner.id, project.id, assignmentId, { editMode: 'ai_only' });
    const aiOnly = await core.load(designer.id, project.id, 'write', 'design');
    assert.throws(() => core.assertEditWay(aiOnly, 'design', 'manual'), /EDIT_MANUAL_FORBIDDEN/);
    core.assertEditWay(aiOnly, 'design', 'ai');
    core.assertEditWay(await core.load(owner.id, project.id, 'write', 'design'), 'design', 'manual');
    await specialists.updateAccess(owner.id, project.id, assignmentId, { editMode: 'manual_only' });
    const manualOnly = await core.load(designer.id, project.id, 'write', 'design');
    assert.throws(() => core.assertEditWay(manualOnly, 'design', 'ai'), /EDIT_AI_FORBIDDEN/);
    assert.equal((await specialists.list(owner.id, project.id, 'design')).data.assignments[0]!.access.editMode, 'manual_only');
  });
});
