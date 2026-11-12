import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from './billing.service.js';

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Restores AI prices it changes. */
describe('project AI spending cap (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT ai_spend_limit_tiyn FROM projects LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const billing = prisma ? new BillingService(prisma) : null;
  let ownerId = '';
  let previousPricing: Awaited<ReturnType<PrismaService['aiPricing']['findUnique']>> = null;

  after(async () => {
    if (!prisma) return;
    if (ownerId) {
      await prisma.project.deleteMany({ where: { ownerUserId: ownerId } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: ownerId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    }
    if (previousPricing) await prisma.aiPricing.update({ where: { id: 1 }, data: { inputPerMillionTiyn: previousPricing.inputPerMillionTiyn, outputPerMillionTiyn: previousPricing.outputPerMillionTiyn, billingMode: previousPricing.billingMode } });
    else await prisma.aiPricing.deleteMany({ where: { id: 1 } });
    await prisma.$disconnect();
  });

  it('lets a request start while a typical one fits, refuses it after, and allows again without a cap', { skip }, async () => {
    previousPricing = await prisma!.aiPricing.findUnique({ where: { id: 1 } });
    // 1 500 ₸ and 6 000 ₸ per million tokens: a typical request (4 000 in, 1 500 out) costs 15 ₸.
    const pricing = { inputPerMillionTiyn: 150_000, outputPerMillionTiyn: 600_000, billingMode: 'off' };
    await prisma!.aiPricing.upsert({ where: { id: 1 }, create: { id: 1, ...pricing }, update: pricing });

    const email = `cap-${randomUUID()}@test.local`;
    ownerId = (await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date() } })).id;
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: ownerId, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: ownerId, name: 'Лимит', startMode: 'build', aiSpendLimitTiyn: 10_000 } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'content', definitionVersion: '1', position: 1, status: 'in_progress' } });
    const run = (costTiyn: number) => prisma!.generationRun.create({ data: { projectId: project.id, stageId: stage.id, requestedByUserId: ownerId, provider: 'openai', playbookVersion: '1', status: 'succeeded', durationMs: 1, costTiyn } });

    await run(8_000); // 80 of 100 ₸: 80 + 15 still fits
    const hold = await billing!.reserveAi(project.id);
    await billing!.releaseAi(hold);

    await run(1_000); // 90 + 15 > 100
    await assert.rejects(billing!.reserveAi(project.id), (error: unknown) => (error as { response?: { message?: string } }).response?.message === 'PROJECT_SPEND_LIMIT');

    await prisma!.project.update({ where: { id: project.id }, data: { aiSpendLimitTiyn: null } });
    await billing!.releaseAi(await billing!.reserveAi(project.id));
  });
});
