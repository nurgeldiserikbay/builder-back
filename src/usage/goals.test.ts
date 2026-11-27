import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { ProjectsService } from '../projects/projects.service.js';
import { goalHint, goalProgress, readGoals } from './goals.js';
import { dayOf, UsageService } from './usage.service.js';

const metrics = [{ key: 'm1', text: '50 заявок в месяц через приложение' }, { key: 'm2', text: '200 посетителей в неделю' }, { key: 'm3', text: 'Мастера довольны' }];

describe('success goals of the idea review measured by the usage counters', () => {
  it('reads a number, a period and a kind from the goal\'s own words as a hint', () => {
    assert.deepEqual(goalHint('50 заявок в месяц через приложение'), { target: 50, period: 'month', kind: 'action' });
    assert.deepEqual(goalHint('1 200 посетителей в неделю'), { target: 1200, period: 'week', kind: 'visitors' });
    assert.deepEqual(goalHint('Мастера довольны'), { target: null, period: null, kind: null });
  });

  it('accepts only goals of the idea review, each once, with a counter, a number and a period', () => {
    const keys = metrics.map((metric) => metric.key);
    assert.deepEqual(readGoals([{ metricKey: 'm1', kind: 'action', name: 'Заявка отправлена', target: 50, period: 'month' }], keys), [{ metricKey: 'm1', kind: 'action', name: 'заявка отправлена', target: 50, period: 'month' }]);
    assert.deepEqual(readGoals([{ metricKey: 'm2', kind: 'visitors', name: 'x', target: 200, period: 'week' }], keys)[0]!.name, null);
    for (const bad of [[{ metricKey: 'm9', kind: 'views', target: 1, period: 'week' }], [{ metricKey: 'm1', kind: 'views', target: 0, period: 'week' }], [{ metricKey: 'm1', kind: 'action', name: '', target: 5, period: 'week' }],
      [{ metricKey: 'm1', kind: 'views', target: 5, period: 'day' }], [{ metricKey: 'm1', kind: 'views', target: 5, period: 'week' }, { metricKey: 'm1', kind: 'views', target: 5, period: 'week' }], 'x', Array(4).fill({})]) {
      assert.throws(() => readGoals(bad, keys), /INVALID_GOALS/, JSON.stringify(bad));
    }
  });

  it('counts the last 7 days for a weekly goal and 30 for a monthly one', () => {
    const today = dayOf(new Date('2026-11-27T12:00:00Z'));
    const day = (back: number) => new Date(today.getTime() - back * 86_400_000);
    const rows = [
      { day: day(0), kind: 'action', name: 'заявка отправлена', count: 20 }, { day: day(20), kind: 'action', name: 'заявка отправлена', count: 40 },
      { day: day(40), kind: 'action', name: 'заявка отправлена', count: 99 }, { day: day(1), kind: 'action', name: 'другое', count: 5 },
      { day: day(2), kind: 'visitors', name: '', count: 100 }, { day: day(10), kind: 'visitors', name: '', count: 300 },
    ];
    const goals = [{ metricKey: 'm1', kind: 'action' as const, name: 'заявка отправлена', target: 50, period: 'month' as const }, { metricKey: 'm2', kind: 'visitors' as const, name: null, target: 200, period: 'week' as const }];
    const progress = goalProgress(goals, metrics, rows, today, true);
    assert.deepEqual(progress.map((item) => [item.metricKey, item.actual, item.percent, item.status]), [['m1', 60, 100, 'reached'], ['m2', 100, 50, 'behind'], ['m3', null, null, 'not_set']]);
    assert.deepEqual(progress[2]!.hint, { target: null, period: null, kind: null });
    assert.equal(goalProgress(goals, metrics, [], today, false)[0]!.status, 'no_data');
  });
});

describe('success goals (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT goals FROM usage_collectors LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('the owner says how a goal is counted; the report shows its progress', { skip }, async () => {
    process.env.PUBLIC_API_URL ||= 'https://api.example.com';
    const billing = new BillingService(prisma!);
    const service = new UsageService(prisma!, new JourneyCore(prisma!, billing));
    const email = `goals-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'CRM', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    // No idea review yet: no goals to count.
    assert.deepEqual((await service.get(owner.id, projectId, '7')).data.goals, []);
    const idea = await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'idea' } });
    const version = await prisma!.stageArtifactVersion.create({ data: { projectId, stageId: idea.id, versionNumber: 1, artifactType: 'idea', content: { metrics }, origin: 'owner_edit', createdByUserId: owner.id } });
    await prisma!.projectStage.update({ where: { id: idea.id }, data: { status: 'approved', currentVersionId: version.id, approvedVersionId: version.id } });

    const before = (await service.get(owner.id, projectId, '7')).data;
    assert.deepEqual(before.goals.map((goal) => goal.status), ['not_set', 'not_set', 'not_set']);
    assert.equal(before.goals[0]!.hint!.target, 50);
    await assert.rejects(service.setGoals(owner.id, projectId, [{ metricKey: 'nope', kind: 'views', target: 1, period: 'week' }]), /INVALID_GOALS/);
    // Setting goals before counting is turned on keeps counting off.
    const set = (await service.setGoals(owner.id, projectId, [{ metricKey: 'm1', kind: 'action', name: 'заявка отправлена', target: 2, period: 'month' }])).data;
    assert.equal(set.enabled, false);
    assert.equal(set.url, null);
    assert.equal(set.goals[0]!.status, 'no_data');
    const on = (await service.set(owner.id, projectId, { enabled: true })).data;
    const token = on.url!.split('/').at(-1)!;
    const browser = 'Mozilla/5.0 (iPhone) Mobile Safari';
    await service.receive(token, '10.2.0.1', browser, { kind: 'action', name: 'Заявка отправлена' });
    await service.receive(token, '10.2.0.2', browser, { kind: 'action', name: 'Заявка отправлена' });
    const after = (await service.get(owner.id, projectId, '7')).data;
    assert.deepEqual([after.goals[0]!.actual, after.goals[0]!.status], [2, 'reached']);
    assert.deepEqual(after.actionNames, ['заявка отправлена']);
    assert.equal((await prisma!.projectEvent.count({ where: { projectId, type: 'usage_goals_changed' } })), 1);
  });
});
