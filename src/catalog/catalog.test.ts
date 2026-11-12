import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { CatalogService } from './catalog.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Removes only what it created. */
describe('specialist catalog and reviews (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM specialist_reviews LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const catalog = prisma ? new CatalogService(prisma) : null;
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

  it('publishes a card, hides its e-mail, takes reviews only for accepted work and lets the specialist answer once', { skip }, async () => {
    const owner = await user('owner');
    const specialist = await user('writer');
    const outsider = await user('outsider');

    // An unpublished card is not in the catalog.
    const saved = await catalog!.saveMine(specialist.id, { displayName: 'Айгерим', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: null, published: false });
    const profileId = saved.data.profile!.id;
    assert.ok(!(await catalog!.list('content')).data.specialists.some((card) => card.id === profileId));
    await assert.rejects(catalog!.emailForInvite(profileId), /PROFILE_NOT_FOUND/);

    await catalog!.saveMine(specialist.id, { displayName: 'Айгерим', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: null, published: true });
    const listed = (await catalog!.list('content')).data.specialists.find((card) => card.id === profileId);
    assert.ok(listed);
    assert.equal(listed.hourlyRate, 5000);
    assert.ok(!JSON.stringify(listed).includes('@'));
    assert.ok(!(await catalog!.list('design')).data.specialists.some((card) => card.id === profileId));
    assert.equal(await catalog!.emailForInvite(profileId), specialist.emailNormalized);

    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'active', projectType: 'booking' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'content', definitionVersion: '1', position: 1, status: 'in_progress' } });
    const assignment = await prisma!.stageAssignment.create({ data: { projectId: project.id, stageId: stage.id, userId: specialist.id, email: specialist.emailNormalized, role: 'lead', status: 'active', inviteTokenHash: randomUUID().replace(/-/g, ''), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: owner.id } });

    // Work not accepted yet; a stranger cannot review at all.
    await assert.rejects(catalog!.review(owner.id, project.id, assignment.id, 5, null), /REVIEW_NOT_AVAILABLE/);
    await prisma!.stageAssignment.update({ where: { id: assignment.id }, data: { status: 'completed', completedAt: new Date() } });
    await assert.rejects(catalog!.review(outsider.id, project.id, assignment.id, 5, null), /PROJECT_NOT_FOUND/);
    await assert.rejects(catalog!.review(owner.id, project.id, assignment.id, 2, ''), /REVIEW_TEXT_REQUIRED/);

    await catalog!.review(owner.id, project.id, assignment.id, 4, 'Быстро и по делу');
    await catalog!.review(owner.id, project.id, assignment.id, 5, 'Быстро и по делу'); // edit within 14 days
    assert.equal(await prisma!.specialistReview.count({ where: { assignmentId: assignment.id } }), 1);

    const card = await catalog!.get(profileId, owner.id);
    assert.equal(card.data.rating, 5);
    assert.equal(card.data.reviews.length, 1);
    assert.equal(card.data.completedStages, 1);
    assert.equal(card.data.reviews[0].canReply, false);
    assert.ok(!JSON.stringify(card.data).includes('Торты')); // the project is not named

    const reviewId = card.data.reviews[0].id;
    await assert.rejects(catalog!.reply(outsider.id, reviewId, 'Спасибо'), /REVIEW_NOT_FOUND/);
    await catalog!.reply(specialist.id, reviewId, 'Спасибо!');
    await assert.rejects(catalog!.reply(specialist.id, reviewId, 'Ещё раз'), /REVIEW_ALREADY_REPLIED/);
    assert.equal((await catalog!.get(profileId, specialist.id)).data.reviews[0].reply, 'Спасибо!');

    // An account being deleted disappears from the catalog at once.
    await prisma!.user.update({ where: { id: specialist.id }, data: { deletionRequestedAt: new Date() } });
    assert.ok(!(await catalog!.list(null)).data.specialists.some((item) => item.id === profileId));
  });
});
