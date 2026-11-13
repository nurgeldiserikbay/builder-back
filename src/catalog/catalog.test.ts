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

    await catalog!.saveMine(specialist.id, { displayName: 'Айгерим', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: null, published: true },
      [{ title: 'Сайт кондитерской', description: 'Тексты и структура', url: 'https://www.tort.kz/', stageKey: 'content' }]);
    await assert.rejects(catalog!.saveMine(specialist.id, { displayName: 'Айгерим', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: null, published: true }, [{ title: 'Ссылка', url: 'javascript:alert(1)' }]), /PORTFOLIO_URL_INVALID/);
    // Saving without the portfolio field (an older client) keeps it.
    await catalog!.saveMine(specialist.id, { displayName: 'Айгерим', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: null, published: true });
    const withWorks = await catalog!.get(profileId, owner.id);
    assert.deepEqual(withWorks.data.portfolio, [{ title: 'Сайт кондитерской', description: 'Тексты и структура', url: 'https://www.tort.kz/', stageKey: 'content', stageTitle: 'Структура и тексты', host: 'tort.kz', photoId: null }]);
    assert.equal((await catalog!.list('content')).data.specialists.find((card) => card.id === profileId)?.works, 1);
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

    // The specialist reports the review once; support hides it, it leaves the card and the rating, and editing cannot bring it back.
    await assert.rejects(catalog!.report(outsider.id, reviewId, 'Отзыв не про мою работу'), /REVIEW_NOT_FOUND/);
    await catalog!.report(specialist.id, reviewId, 'Отзыв не про мою работу, а про другой проект');
    await assert.rejects(catalog!.report(specialist.id, reviewId, 'Ещё раз пожалуюсь на тот же отзыв'), /REVIEW_ALREADY_REPORTED/);
    assert.equal((await catalog!.get(profileId, specialist.id)).data.reviews[0].reportStatus, 'pending');
    assert.ok((await catalog!.staffReports('pending')).data.some((row) => row.id === reviewId));
    const staffEmail = `staff-${randomUUID()}@test.local`;
    const staffId = (await prisma!.staffAccount.create({ data: { email: staffEmail, emailNormalized: staffEmail, passwordHash: 'x', displayName: 'Support', role: 'super_admin' } })).id;
    try {
      await assert.rejects(catalog!.staffDecide(staffId, reviewId, 'hide', ''), /MODERATION_NOTE_REQUIRED/);
      await catalog!.staffDecide(staffId, reviewId, 'hide', 'Отзыв о другом проекте');
      await assert.rejects(catalog!.staffDecide(staffId, reviewId, 'keep', 'Передумали'), /REVIEW_NOT_REPORTED/);
      const hiddenCard = await catalog!.get(profileId, owner.id);
      assert.equal(hiddenCard.data.reviews.length, 0);
      assert.equal(hiddenCard.data.rating, null);
      await assert.rejects(catalog!.review(owner.id, project.id, assignment.id, 5, 'Исправил отзыв'), /REVIEW_HIDDEN/);
    } finally {
      await prisma!.adminAuditEvent.deleteMany({ where: { staffId } });
      await prisma!.staffAccount.deleteMany({ where: { id: staffId } });
    }

    // An account being deleted disappears from the catalog at once.
    await prisma!.user.update({ where: { id: specialist.id }, data: { deletionRequestedAt: new Date() } });
    assert.ok(!(await catalog!.list(null)).data.specialists.some((item) => item.id === profileId));
  });
  it('portfolio photos: upload, put on a work, visibility and deletion', { skip }, async () => {
    process.env.UPLOAD_MALWARE_SCAN = 'disabled';
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c86' } }).png().toBuffer();
    const author = await user('photo-author');
    const viewer = await user('photo-viewer');
    const base = { displayName: 'Данияр', headline: 'Сайты для кафе', about: null, stageKeys: ['design'], hourlyRate: null, city: null };

    await assert.rejects(catalog!.uploadPhoto(author.id, { buffer: Buffer.from('not an image'), size: 12 }), /IMAGE_TYPE_NOT_SUPPORTED/);
    const uploaded = (await catalog!.uploadPhoto(author.id, { buffer: png, size: png.length })).data;
    assert.equal(uploaded.width, 40);
    const other = (await catalog!.uploadPhoto(viewer.id, { buffer: png, size: png.length })).data;

    // Only the author's own photo may be put on a work.
    await assert.rejects(catalog!.saveMine(author.id, { ...base, published: false }, [{ title: 'Кафе', photoId: other.id }]), /PORTFOLIO_PHOTO_INVALID:0/);
    await catalog!.saveMine(author.id, { ...base, published: false }, [{ title: 'Кафе', photoId: uploaded.id }]);

    // The author sees it; others only once the profile is published.
    assert.ok((await catalog!.photo(author.id, uploaded.id)).data.length > 0);
    await assert.rejects(catalog!.photo(viewer.id, uploaded.id), /PHOTO_NOT_FOUND/);
    await catalog!.saveMine(author.id, { ...base, published: true }, [{ title: 'Кафе', photoId: uploaded.id }]);
    const served = await catalog!.photo(viewer.id, uploaded.id);
    assert.equal((await sharp(served.data).metadata()).format, 'webp');
    // A photo nobody shows stays private.
    await assert.rejects(catalog!.photo(author.id, other.id), /PHOTO_NOT_FOUND/);

    await assert.rejects(catalog!.deletePhoto(author.id, uploaded.id), /PORTFOLIO_PHOTO_IN_USE/);
    await assert.rejects(catalog!.deletePhoto(author.id, other.id), /PHOTO_NOT_FOUND/);
    await catalog!.saveMine(author.id, { ...base, published: true }, [{ title: 'Кафе' }]);
    await catalog!.deletePhoto(author.id, uploaded.id);
    assert.equal(await prisma!.specialistPhoto.count({ where: { userId: author.id } }), 0);
  });
});
