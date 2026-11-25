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
import { ChangeProposalsService } from './change-proposals.service.js';

/** A specialist proposes to change an accepted requirement; the owner decides — against DATABASE_URL; skipped without it. */
describe('change proposals (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM change_proposals LIMIT 1`; } catch { prisma = null; }
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

  it('takes effect only after the owner accepts it, and reopens the requirement', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const ai = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, ai, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, ai));
    const proposals = new ChangeProposalsService(prisma!, core, journey, ai);

    const owner = await user('owner');
    const writer = await user('writer');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing', routeVersion: '1.0.0' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const stages: Record<string, string> = {};
    for (const [position, key] of ['goal', 'process', 'techplan', 'content', 'design', 'build'].entries()) {
      stages[key] = (await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: key, definitionVersion: '1', position, status: key === 'goal' ? 'approved' : key === 'content' ? 'ready' : 'locked' } })).id;
    }
    const brief = { businessName: 'Торты', whatYouDo: 'Печём торты', audience: 'Родители', city: null, mainAction: 'message', phone: null, messenger: '@cakes', email: null, address: null, tone: 'friendly' };
    const version = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: stages.goal!, versionNumber: 1, artifactType: 'brief', content: brief, origin: 'owner_edit', createdByUserId: owner.id } });
    await prisma!.projectStage.update({ where: { id: stages.goal }, data: { currentVersionId: version.id, approvedVersionId: version.id } });
    await prisma!.stageAssignment.create({ data: { projectId: project.id, stageId: stages.content!, userId: writer.id, email: writer.email, role: 'lead', status: 'active', inviteTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: owner.id } });

    // Only to an earlier stage the author can see, with a real explanation.
    await assert.rejects(proposals.create(writer.id, project.id, 'content', { targetStageKey: 'design', text: 'Поменяйте цвета на тёплые' }), /PROPOSAL_TARGET_INVALID/);
    await assert.rejects(proposals.create(writer.id, project.id, 'content', { targetStageKey: 'goal', text: 'коротко' }), /PROPOSAL_TEXT_INVALID/);
    const first = (await proposals.create(writer.id, project.id, 'content', { targetStageKey: 'goal', text: 'Клиенты — не только родители, но и офисы: торты на корпоративы.' })).data;
    const second = (await proposals.create(writer.id, project.id, 'content', { targetStageKey: 'goal', text: 'Главное действие — звонок, а не сообщение.' })).data;
    const third = (await proposals.create(writer.id, project.id, 'content', { targetStageKey: 'goal', text: 'Добавьте город Алматы в паспорт.' })).data;

    // Nothing changed yet.
    assert.equal((await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } })).status, 'approved');
    assert.equal((await journey.journey(owner.id, project.id)).data.openProposals, 3);
    assert.equal((await proposals.list(writer.id, project.id)).data.canDecide, false);
    await assert.rejects(proposals.decide(writer.id, project.id, first.id, { decision: 'accept' }), /STAGE_NOT_FOUND|STAGE_ACCEPT_FORBIDDEN/);

    // A question from the owner, blocking: the content stage cannot be accepted until it is answered.
    const content = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: stages.content!, versionNumber: 1, artifactType: 'content', content: { sections: [], seo: { title: 'T', description: 'D' } }, origin: 'owner_edit', createdByUserId: owner.id } });
    await prisma!.projectStage.update({ where: { id: stages.content }, data: { currentVersionId: content.id, status: 'in_progress' } });
    const question = (await proposals.create(owner.id, project.id, 'content', { targetStageKey: 'goal', kind: 'question', blocking: true, text: 'Торты только на заказ или есть готовые на витрине?' })).data;
    assert.deepEqual([question.kind, question.blocking], ['question', true]);
    await assert.rejects(journey.accept(owner.id, project.id, 'content', content.id), /STAGE_BLOCKED_BY_REQUEST/);
    const page = (await journey.stage(owner.id, project.id, 'content')).data.stage as unknown as { requests: { outgoing: Array<{ id: string; blocking: boolean }> } };
    assert.deepEqual(page.requests.outgoing.filter((item) => item.blocking).map((item) => item.id), [question.id]);
    assert.equal(page.requests.outgoing.length, 4);
    // The specialist of the content stage cannot answer for the goal: answering needs write access to the earlier stage.
    await assert.rejects(proposals.decide(writer.id, project.id, question.id, { decision: 'answer', note: 'Только на заказ' }), /FORBIDDEN|NOT_FOUND/);
    await assert.rejects(proposals.decide(owner.id, project.id, question.id, { decision: 'answer' }), /ANSWER_INVALID/);
    await proposals.decide(owner.id, project.id, question.id, { decision: 'answer', note: 'Только на заказ, за два дня.' });
    // Answered: nothing in the goal changed, and the content stage is free again (it fails later checks, not the blocker).
    assert.equal((await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } })).status, 'approved');
    await assert.rejects(journey.accept(owner.id, project.id, 'content', content.id), (error: Error) => !/STAGE_BLOCKED_BY_REQUEST/.test(error.message));

    // Reject with a note; withdraw; accept — the requirement reopens for the owner.
    await proposals.decide(owner.id, project.id, second.id, { decision: 'reject', note: 'Звонки неудобны, оставляем сообщения.' });
    await proposals.withdraw(writer.id, project.id, third.id);
    await assert.rejects(proposals.withdraw(writer.id, project.id, second.id), /PROPOSAL_NOT_FOUND/);
    const accepted = (await proposals.decide(owner.id, project.id, first.id, { decision: 'accept' })).data;
    assert.equal(accepted.status, 'accepted');
    assert.notEqual((await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } })).status, 'approved');
    await assert.rejects(proposals.decide(owner.id, project.id, first.id, { decision: 'reject' }), /PROPOSAL_ALREADY_DECIDED/);

    // Fixed and accepted again: the request resolves itself and points at the version that fixed it.
    const goal = await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } });
    await journey.saveDraft(owner.id, project.id, 'goal', { content: { ...brief, audience: 'Родители и офисы' }, baseVersionId: goal.currentVersionId });
    await journey.accept(owner.id, project.id, 'goal', (await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } })).currentVersionId!);
    const fixed = await prisma!.changeProposal.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(fixed.status, 'resolved');
    assert.equal(fixed.resolvedVersionId, (await prisma!.projectStage.findUniqueOrThrow({ where: { id: stages.goal } })).approvedVersionId);

    const mine = (await proposals.list(writer.id, project.id)).data.proposals;
    assert.deepEqual(mine.map((item) => item.status).sort(), ['rejected', 'resolved', 'withdrawn']);
    assert.equal(mine.find((item) => item.status === 'rejected')!.decisionNote, 'Звонки неудобны, оставляем сообщения.');
    const events = await prisma!.projectEvent.findMany({ where: { projectId: project.id, type: { in: ['change_proposal_accepted', 'change_proposal_rejected', 'change_proposal_withdrawn', 'change_proposed'] } }, select: { type: true } });
    assert.deepEqual(events.map((event) => event.type).sort(), ['change_proposal_accepted', 'change_proposal_rejected', 'change_proposal_withdrawn', 'change_proposed', 'change_proposed', 'change_proposed']);
  });
});
