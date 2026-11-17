import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { Brief } from './artifacts.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { JourneyCore } from './journey-core.js';
import { JourneyService } from './journey.service.js';
import { templateProcess, type BusinessProcess } from './process.js';
import { SITUATIONS } from './situations.js';
import { StageAiService } from './stage-ai.service.js';
import { StageReviewService } from './stage-review.service.js';
import { WorktimeService } from './worktime.service.js';

describe('«Вы это учли?» in a project (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM project_stages LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('asks the questions of a booking site, blocks acceptance without the cancellation answer, keeps the AI out of it and turns answers into rules', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const worktime = new WorktimeService(prisma!);
    const stageAi = new StageAiService(prisma!, core, worktime);
    const review = new StageReviewService(prisma!, core, stageAi);
    const journey = new JourneyService(prisma!, billing, worktime, core, stageAi, new ChangeNoticesService(prisma!, core), review);
    const email = `sit-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Барбершоп', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;
    const brief: Brief = { businessName: 'Барбершоп Усы', whatYouDo: 'Мужские стрижки и бритьё в центре города', audience: 'Мужчины, которые следят за собой', city: 'Алматы', mainAction: 'message', phone: null, messenger: '@usy', email: null, address: null, tone: 'friendly' };
    const current = async (key: string) => (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId;
    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await journey.accept(owner.id, projectId, 'goal', (await current('goal'))!);

    // The stage page brings the questions of this kind of business.
    const detail = await journey.stage(owner.id, projectId, 'process') as unknown as { data: { options: { process: { situations: { items: Array<{ key: string }> } } } } };
    const asked = detail.data.options.process.situations.items.map((item) => item.key);
    assert.ok(asked.includes('booking_cancel') && asked.includes('no_show') && !asked.includes('returns'));

    await journey.saveDraft(owner.id, projectId, 'process', { content: templateProcess('booking', brief), baseVersionId: null });
    const draft = (await current('process'))!;
    await assert.rejects(journey.accept(owner.id, projectId, 'process', draft), /REVIEW_BLOCKING_OPEN:PROCESS_SITUATION_OPEN:situation:booking_cancel/);
    // A decision about the business is not the AI's to make.
    await assert.rejects(review.fix(owner.id, projectId, 'process', { findingIds: ['PROCESS_SITUATION_OPEN:situation:booking_cancel'] }), /OWNER_DECIDES/);

    const version = await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: draft } });
    const answered: BusinessProcess = { ...(version.content as unknown as BusinessProcess), situations: [{ key: 'booking_cancel', answer: 'hours_24' }, { key: 'no_show', answer: 'later' }] };
    await journey.saveDraft(owner.id, projectId, 'process', { content: answered, baseVersionId: draft });
    const saved = (await prisma!.stageArtifactVersion.findUniqueOrThrow({ where: { id: (await current('process'))! } })).content as unknown as BusinessProcess;
    const cancelRule = SITUATIONS.find((item) => item.key === 'booking_cancel')!.options.find((option) => option.value === 'hours_24')!.rule;
    assert.ok(saved.rules.includes(cancelRule));
    await journey.accept(owner.id, projectId, 'process', (await current('process'))!);
    const stage = await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'process' } });
    assert.equal(stage.status, 'approved');
  });
});
