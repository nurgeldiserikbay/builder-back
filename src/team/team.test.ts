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
import { TeamService } from './team.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Removes only what it created. */
describe('project team and approvals (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM project_invitations LIMIT 1`;
  } catch {
    prisma = null;
  }
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

  it('invites by address, limits who manages whom, and accepts a stage only when the policy is met', { skip }, async () => {
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    const billing = new BillingService(prisma!);
    const team = new TeamService(prisma!, billing);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));

    const owner = await user('owner');
    const writer = await user('writer');
    const rev1 = await user('rev1');
    const rev2 = await user('rev2');
    const stranger = await user('stranger');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'goal', definitionVersion: '1', position: 0, status: 'in_progress' } });
    for (const [position, key] of ['process', 'techplan', 'content', 'design', 'build'].entries()) {
      await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position: position + 1, status: 'locked' } });
    }

    // A team is part of paid plans.
    await assert.rejects(team.invite(owner.id, project.id, { email: writer.email, role: 'contributor' }), /PLAN_NO_TEAM/);
    await prisma!.accountPlan.create({ data: { userId: owner.id, planKey: 'start' } });

    const invites: Record<string, string> = {};
    for (const [person, role] of [[writer, 'contributor'], [rev1, 'reviewer'], [rev2, 'reviewer']] as const) {
      const sent = await team.invite(owner.id, project.id, { email: person.email.toUpperCase(), role });
      invites[person.id] = new URL(sent.data.inviteUrl).pathname.split('/').pop()!;
    }
    await assert.rejects(team.invite(owner.id, project.id, { email: writer.email, role: 'viewer' }), /ALREADY_INVITED/);
    assert.equal((await team.info(invites[writer.id]!)).data.roleTitle, 'Исполнитель');
    // Bound to the address: a forwarded link does not work for someone else.
    await assert.rejects(team.accept(stranger.id, stranger.email, invites[writer.id]!), /INVITE_EMAIL_MISMATCH/);
    for (const person of [writer, rev1, rev2]) await team.accept(person.id, person.email, invites[person.id]!);
    assert.deepEqual((await team.accept(writer.id, writer.email, invites[writer.id]!)).data, { projectId: project.id });

    // Members other than managers see names, not addresses, and cannot manage.
    const seen = await team.list(rev1.id, project.id);
    assert.equal(seen.data.canManage, false);
    assert.ok(seen.data.members.every((member) => member.email === null));
    await assert.rejects(team.invite(rev1.id, project.id, { email: 'x@test.local', role: 'viewer' }), /TEAM_MANAGE_FORBIDDEN/);
    await assert.rejects(team.list(stranger.id, project.id), /PROJECT_NOT_FOUND/);
    const ownerSees = await team.list(owner.id, project.id);
    const writerRow = ownerSees.data.members.find((member) => member.userId === writer.id)!;
    assert.equal(writerRow.email, writer.email);

    // A reviewer cannot write.
    const brief = { businessName: 'Торты', whatYouDo: 'Печём торты на заказ', audience: 'Родители', city: null, mainAction: 'message', phone: null, messenger: '@cakes', email: null, address: null, tone: 'friendly' };
    await assert.rejects(journey.saveDraft(rev1.id, project.id, 'goal', { content: brief, baseVersionId: null }), /STAGE_WRITE_FORBIDDEN/);
    await journey.saveDraft(writer.id, project.id, 'goal', { content: brief, baseVersionId: null });
    const version = (await prisma!.projectStage.findUniqueOrThrow({ where: { id: stage.id } })).currentVersionId!;

    // Policy: all reviewers, and the author (writer) is one of them but does not count.
    await assert.rejects(journey.setApprovalPolicy(rev1.id, project.id, 'goal', { mode: 'all', reviewers: [rev1.id], quorum: null, authorMayApprove: false }), /STAGE_ACCEPT_FORBIDDEN/);
    await journey.setApprovalPolicy(owner.id, project.id, 'goal', { mode: 'all', reviewers: [rev1.id, rev2.id, writer.id], quorum: null, authorMayApprove: false });
    await assert.rejects(journey.accept(owner.id, project.id, 'goal', version), /APPROVAL_POLICY_ACTIVE/);
    await assert.rejects(journey.approve(rev1.id, project.id, 'goal', version, null), /STAGE_NOT_IN_REVIEW/);
    await journey.submit(writer.id, project.id, 'goal', version);

    await assert.rejects(journey.approve(writer.id, project.id, 'goal', version, null), /AUTHOR_CANNOT_APPROVE/);
    await assert.rejects(journey.approve(owner.id, project.id, 'goal', version, null), /NOT_A_REVIEWER/);
    let view = await journey.approve(rev1.id, project.id, 'goal', version, 'Всё верно');
    assert.equal(view.data.stage.status, 'in_review');
    assert.deepEqual([view.data.stage.approval.approved, view.data.stage.approval.required], [1, 2]);
    await assert.rejects(journey.approve(rev1.id, project.id, 'goal', version, null), /ALREADY_APPROVED/);

    // Changes requested by a reviewer start a new round: rev1's approval no longer counts.
    await journey.requestChanges(rev2.id, project.id, 'goal', 'Уточните аудиторию');
    await journey.saveDraft(writer.id, project.id, 'goal', { content: { ...brief, audience: 'Родители детей до 10 лет' }, baseVersionId: version });
    const second = (await prisma!.projectStage.findUniqueOrThrow({ where: { id: stage.id } })).currentVersionId!;
    await journey.submit(writer.id, project.id, 'goal', second);
    view = await journey.stage(rev1.id, project.id, 'goal');
    assert.equal(view.data.stage.approval.approved, 0);

    // Both approve concurrently: the stage is accepted exactly once.
    const results = await Promise.allSettled([journey.approve(rev1.id, project.id, 'goal', second, null), journey.approve(rev2.id, project.id, 'goal', second, null)]);
    assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results));
    const accepted = await prisma!.projectStage.findUniqueOrThrow({ where: { id: stage.id } });
    assert.equal(accepted.status, 'approved');
    assert.equal(accepted.approvedVersionId, second);
    assert.equal(await prisma!.projectEvent.count({ where: { projectId: project.id, type: 'stage_accepted' } }), 1);

    // Removing a reviewer reports the stages whose policy names them.
    const rev2Row = (await team.list(owner.id, project.id)).data.members.find((member) => member.userId === rev2.id)!;
    const removed = await team.remove(owner.id, project.id, rev2Row.id);
    assert.deepEqual(removed.data.affectedStages, ['goal']);
    await assert.rejects(journey.stage(rev2.id, project.id, 'goal'), /PROJECT_NOT_FOUND|NOT_FOUND/);
    const writerMember = (await team.list(owner.id, project.id)).data.members.find((member) => member.userId === writer.id)!;
    await team.changeRole(owner.id, project.id, writerMember.id, 'manager');
    // A manager cannot touch another manager or the owner.
    const ownerRow = (await team.list(owner.id, project.id)).data.members.find((member) => member.userId === owner.id)!;
    await assert.rejects(team.remove(writer.id, project.id, ownerRow.id), /ROLE_NOT_ALLOWED/);
  });
});
