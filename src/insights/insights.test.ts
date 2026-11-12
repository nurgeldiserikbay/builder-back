import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { VisitCounter, dayIn } from '../sites/visit-counter.js';
import { InsightsService } from './insights.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Removes only what it created. */
describe('after-launch insights (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM site_visit_counts LIMIT 1`;
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

  it('writes counted views and sums them up with leads for project members only', { skip }, async () => {
    const make = async (label: string) => {
      const email = `${label}-${randomUUID()}@test.local`;
      const user = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date() } });
      users.push(user.id);
      return user;
    };
    const owner = await make('owner');
    const stranger = await make('stranger');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'live' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner' } });

    // The real write path: views added in memory and flushed with an upsert, twice for the same key.
    const counter = new VisitCounter(prisma!, 'Asia/Almaty');
    counter.add(project.id, '/', 'direct'); counter.add(project.id, '/', 'direct'); counter.add(project.id, '/services', 'instagram.com');
    assert.equal(await counter.flush(), 3);
    counter.add(project.id, '/', 'direct');
    assert.equal(await counter.flush(), 1);
    const yesterdayOfPrevious = new Date(Date.now() - 40 * 86_400_000);
    await prisma!.siteVisitCount.create({ data: { projectId: project.id, day: new Date(`${dayIn('Asia/Almaty', yesterdayOfPrevious)}T00:00:00Z`), path: '/', source: 'direct', views: 2 } });
    await prisma!.siteLead.create({ data: { projectId: project.id, publicationId: (await prisma!.sitePublication.create({ data: { projectId: project.id, slug: `t-${randomUUID().slice(0, 8)}`, status: 'live', buildVersionId: randomUUID(), publishedAt: new Date(), publishedByUserId: owner.id } })).id, name: 'Айгуль', contact: '+77010000000', consentAt: new Date(), ipHash: 'x'.repeat(64) } });

    const insights = new InsightsService(prisma!);
    await assert.rejects(insights.project(stranger.id, project.id, 30), /PROJECT_NOT_FOUND/);
    const month = (await insights.project(owner.id, project.id, '30')).data;
    assert.equal(month.published, true);
    assert.equal(month.views, 4);
    assert.equal(month.daily.length, 30);
    assert.equal(month.daily.at(-1)!.views, 4);
    assert.deepEqual(month.pages, [{ name: '/', views: 3 }, { name: '/services', views: 1 }]);
    assert.deepEqual(month.sources, [{ name: 'direct', views: 3 }, { name: 'instagram.com', views: 1 }]);
    assert.equal(month.actions.leads, 1);
    assert.equal(month.actions.perHundredViews, 25);
    assert.equal(month.previousViews, 2);
    assert.equal(month.change, 100);
  });
});
