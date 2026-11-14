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
import { CommentsService } from '../journey/comments.service.js';
import { TeamService } from './team.service.js';

/** Contributors on chosen stages, review in turn and blocking remarks — against DATABASE_URL; skipped without it. */
describe('stage work in a team (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM stage_comments LIMIT 1`; } catch { prisma = null; }
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

  it('limits a contributor to stages, takes approvals in turn and holds the stage on a blocking remark', { skip }, async () => {
    delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY;
    const billing = new BillingService(prisma!);
    const team = new TeamService(prisma!, billing);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const comments = new CommentsService(prisma!, core);

    const owner = await user('owner');
    const writer = await user('writer');
    const first = await user('first');
    const second = await user('second');
    const watcher = await user('watcher');
    await prisma!.accountPlan.create({ data: { userId: owner.id, planKey: 'start' } });
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'goal', definitionVersion: '1', position: 0, status: 'in_progress' } });
    for (const [position, key] of ['process', 'techplan', 'content', 'design', 'build'].entries()) await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position: position + 1, status: 'locked' } });

    // Stages only for contributors, and only stages of the route.
    await assert.rejects(team.invite(owner.id, project.id, { email: first.email, role: 'reviewer', stageKeys: ['goal'] }), /STAGE_KEYS_ONLY_FOR_CONTRIBUTORS/);
    await assert.rejects(team.invite(owner.id, project.id, { email: writer.email, role: 'contributor', stageKeys: ['schedule'] }), /STAGE_KEYS_INVALID/);
    const tokens: Record<string, string> = {};
    for (const [person, role, stageKeys] of [[writer, 'contributor', ['content']], [first, 'reviewer', []], [second, 'reviewer', []], [watcher, 'viewer', []]] as const) {
      tokens[person.id] = new URL((await team.invite(owner.id, project.id, { email: person.email, role, stageKeys: [...stageKeys] })).data.inviteUrl).pathname.split('/').pop()!;
      await team.accept(person.id, person.email, tokens[person.id]!);
    }
    const brief = { businessName: 'Торты', whatYouDo: 'Печём торты', audience: 'Родители', city: null, mainAction: 'message', phone: null, messenger: '@cakes', email: null, address: null, tone: 'friendly' };
    await assert.rejects(journey.saveDraft(writer.id, project.id, 'goal', { content: brief, baseVersionId: null }), /STAGE_WRITE_FORBIDDEN/);
    const writerRow = (await team.list(owner.id, project.id)).data.members.find((member) => member.userId === writer.id)!;
    assert.deepEqual(writerRow.stageKeys, ['content']);
    await team.setStages(owner.id, project.id, writerRow.id, ['goal', 'content']);
    await journey.saveDraft(writer.id, project.id, 'goal', { content: brief, baseVersionId: null });
    const version = (await prisma!.projectStage.findUniqueOrThrow({ where: { id: stage.id } })).currentVersionId!;

    // Review in turn: second, then first.
    await journey.setApprovalPolicy(owner.id, project.id, 'goal', { mode: 'all', reviewers: [second.id, first.id], quorum: null, authorMayApprove: false, order: 'sequential' });
    await journey.submit(writer.id, project.id, 'goal', version);
    await assert.rejects(journey.approve(first.id, project.id, 'goal', version, null), /NOT_YOUR_TURN/);

    // A blocking remark: observers cannot write, a plain member cannot block, a reviewer can — and it holds the stage.
    await assert.rejects(comments.add(watcher.id, project.id, 'goal', { text: 'Мне не нравится', targetKey: null, blocking: false, parentId: null }), /COMMENT_FORBIDDEN/);
    await assert.rejects(comments.add(writer.id, project.id, 'goal', { text: 'Стоп', targetKey: null, blocking: true, parentId: null }), /COMMENT_BLOCKING_FORBIDDEN/);
    const added = await comments.add(second.id, project.id, 'goal', { text: 'Уточните аудиторию', targetKey: 'audience', blocking: true, parentId: null });
    await assert.rejects(comments.add(second.id, project.id, 'goal', { text: 'x y', targetKey: 'nope', blocking: false, parentId: null }), /TARGET_NOT_FOUND/);
    assert.equal(added.data.openBlocking, 1);
    assert.equal(added.data.comments[0]!.versionNumber, 1);
    await assert.rejects(journey.approve(second.id, project.id, 'goal', version, null), /BLOCKING_COMMENTS_OPEN/);
    const thread = added.data.comments[0]!.id;
    await comments.add(writer.id, project.id, 'goal', { text: 'Это родители детей до 10 лет', targetKey: null, blocking: false, parentId: thread });
    // The writer may answer but not close someone else's remark.
    await assert.rejects(comments.resolve(writer.id, project.id, 'goal', thread, true), /COMMENT_RESOLVE_FORBIDDEN/);
    const resolved = await comments.resolve(second.id, project.id, 'goal', thread, true);
    assert.equal(resolved.data.openBlocking, 0);
    assert.equal(resolved.data.comments[0]!.replies.length, 1);

    await journey.approve(second.id, project.id, 'goal', version, null);
    assert.equal((await journey.stage(first.id, project.id, 'goal')).data.stage.approval.canApprove, true);
    await journey.approve(first.id, project.id, 'goal', version, null);
    assert.equal((await prisma!.projectStage.findUniqueOrThrow({ where: { id: stage.id } })).status, 'approved');
  });
});
