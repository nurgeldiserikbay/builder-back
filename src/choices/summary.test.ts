import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ChangeNoticesService } from '../journey/change-notices.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { JourneyService } from '../journey/journey.service.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { StageReviewService } from '../journey/stage-review.service.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChoicesService } from './choices.service.js';

describe('«Уже решено за вас» (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM project_choices LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('a new site has every decision made by default with what it means; the owner\'s choice replaces the default', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, stageAi));
    const choices = new ChoicesService(prisma!, journey);
    const email = `dec-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Усы', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;

    const before = (await choices.summary(owner.id, projectId)).data;
    assert.deepEqual(before.items.map((item) => [item.cardKey, item.optionKey, item.decidedBy]), [
      ['technologies', 'buildpath', 'default'], ['deployment', 'buildpath', 'default'], ['domain', 'buildpath_address', 'default'], ['code_hosting', 'archive', 'default'],
    ]);
    assert.ok(before.items.every((item) => item.now && item.why && item.others.length > 0));
    assert.match(before.items.find((item) => item.cardKey === 'deployment')!.now, /После публикации/);

    await choices.choose(owner.id, projectId, 'technologies', 'developer', null);
    const after = (await choices.summary(owner.id, projectId)).data.items.find((item) => item.cardKey === 'technologies')!;
    assert.deepEqual([after.optionKey, after.decidedBy, after.why], ['developer', 'owner', null]);
    assert.match(after.now, /разработчик/);
    assert.ok(after.others.some((option) => option.key === 'buildpath'));
  });
});
