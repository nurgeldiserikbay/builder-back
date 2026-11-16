import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';

/** Project life cycle: pause, cancel, archive — against DATABASE_URL; skipped without it. */
describe('project status (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 'cancelled'::"ProjectStatus"`; } catch { prisma = null; }
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

  it('pauses, cancels with a reason, frees the plan slot, closes specialists and only lets the owner archive it', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));

    const owner = await user('owner');
    const manager = await user('manager');
    const specialist = await user('specialist');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: manager.id, role: 'manager' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'goal', definitionVersion: '1', position: 0, status: 'in_progress' } });
    for (const [position, key] of ['process', 'techplan', 'content', 'design', 'build'].entries()) await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position: position + 1, status: 'locked' } });
    await prisma!.stageAssignment.create({ data: { projectId: project.id, stageId: stage.id, userId: specialist.id, email: specialist.email, role: 'lead', status: 'active', inviteTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: owner.id } });
    const status = async () => (await prisma!.project.findUniqueOrThrow({ where: { id: project.id } })).status;
    const counted = async () => prisma!.project.count({ where: { ownerUserId: owner.id, projectType: { not: null }, status: { notIn: ['archived', 'cancelled'] } } });

    // Pause: a manager may; stage work stops; resume brings it back.
    await journey.setProjectStatus(manager.id, project.id, 'pause');
    assert.equal(await status(), 'paused');
    await assert.rejects(journey.saveDraft(owner.id, project.id, 'goal', { content: {}, baseVersionId: null }), /PROJECT_NOT_ACTIVE/);
    await assert.rejects(journey.setProjectStatus(manager.id, project.id, 'pause'), /PROJECT_STATUS_CONFLICT/);
    await journey.setProjectStatus(manager.id, project.id, 'resume');
    assert.equal(await status(), 'active');

    // Cancel: owner only; specialists lose access; the project stops counting against the plan.
    assert.equal(await counted(), 1);
    await assert.rejects(journey.setProjectStatus(manager.id, project.id, 'cancel'), /PROJECT_STATUS_FORBIDDEN/);
    await journey.setProjectStatus(owner.id, project.id, 'cancel', '  Передумали открывать  ');
    assert.equal(await status(), 'cancelled');
    assert.equal(await counted(), 0);
    assert.equal((await prisma!.stageAssignment.findFirstOrThrow({ where: { projectId: project.id } })).status, 'revoked');
    const event = await prisma!.projectEvent.findFirstOrThrow({ where: { projectId: project.id, type: 'project_cancelled' } });
    assert.deepEqual(event.details, { reason: 'Передумали открывать' });

    // A cancelled project is read-only and can only go to the archive.
    await assert.rejects(journey.saveDraft(owner.id, project.id, 'goal', { content: {}, baseVersionId: null }), /PROJECT_NOT_ACTIVE/);
    for (const action of ['resume', 'pause', 'complete', 'cancel'] as const) await assert.rejects(journey.setProjectStatus(owner.id, project.id, action), /PROJECT_STATUS_CONFLICT/);
    await journey.setProjectStatus(owner.id, project.id, 'archive');
    assert.equal(await status(), 'archived');

    // A live site has to be taken down first.
    await prisma!.project.update({ where: { id: project.id }, data: { status: 'live' } });
    await assert.rejects(journey.setProjectStatus(owner.id, project.id, 'cancel'), /UNPUBLISH_FIRST/);
  });
});
