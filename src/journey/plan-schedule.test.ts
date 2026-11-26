import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { planForecast, shouldTell, workingDaysBetween } from './plan-schedule.js';
import type { Roadmap } from './roadmap.js';
import { PrismaService } from '../database/prisma.service.js';
import { PlanScheduleService } from './plan-schedule.service.js';
import { InboxService } from '../inbox/inbox.service.js';

// Two modules in a row (b waits for a): both are on the critical path; c runs alongside and is short.
const plan = {
  hoursPerDay: 4, releases: [],
  modules: [
    { key: 'a', name: 'A', summary: '', contractModule: null, dependsOn: [], executor: 'ai', tasks: [{ key: 'a1', title: 'Вход', feature: null, release: 1, hours: 8, aiRequests: 1 }] },
    { key: 'b', name: 'B', summary: '', contractModule: null, dependsOn: ['a'], executor: 'ai', tasks: [{ key: 'b1', title: 'Заявки', feature: null, release: 1, hours: 8, aiRequests: 1 }] },
    { key: 'c', name: 'C', summary: '', contractModule: null, dependsOn: [], executor: 'ai', tasks: [{ key: 'c1', title: 'Отчёт', feature: null, release: 1, hours: 2, aiRequests: 1 }] },
  ],
} as unknown as Roadmap;

describe('plan finish', () => {
  it('counts working days only', () => {
    assert.equal(workingDaysBetween(new Date('2026-11-27'), new Date('2026-11-30')), 1); // Friday → Monday
    assert.equal(workingDaysBetween(new Date('2026-11-30'), new Date('2026-11-27')), -1);
    assert.equal(workingDaysBetween(new Date('2026-11-26'), new Date('2026-11-26')), 0);
  });

  it('follows what is left on the critical path, and names its late tasks', () => {
    const monday = new Date('2026-11-30T09:00:00Z');
    const fresh = planForecast(plan, [], monday);
    assert.equal(fresh.remainingCriticalHours, 16);
    assert.equal(fresh.finish.toISOString().slice(0, 10), '2026-12-04'); // 16 h at 4 h a day: four working days
    const half = planForecast(plan, [{ taskKey: 'a1', status: 'done', dueDate: null }, { taskKey: 'b1', status: 'in_progress', dueDate: new Date('2026-11-27') }], monday);
    assert.equal(half.remainingCriticalHours, 8);
    assert.deepEqual(half.lateCritical, [{ key: 'b1', title: 'Заявки', dueDate: '2026-11-27' }]);
    // A task off the critical path does not move the finish.
    assert.equal(planForecast(plan, [{ taskKey: 'c1', status: 'done', dueDate: null }], monday).remainingCriticalHours, 16);
  });

  it('tells people once the finish moved two working days past the promise, and again only after it moved further', () => {
    const baseline = new Date('2026-12-04');
    assert.equal(shouldTell({ baseline, notified: null, forecast: new Date('2026-12-07') }), false); // one working day
    assert.equal(shouldTell({ baseline, notified: null, forecast: new Date('2026-12-08') }), true);
    assert.equal(shouldTell({ baseline, notified: new Date('2026-12-08'), forecast: new Date('2026-12-09') }), false);
    assert.equal(shouldTell({ baseline, notified: new Date('2026-12-08'), forecast: new Date('2026-12-10') }), true);
  });
});

let prisma: PrismaService | null = null;
try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1`; } catch { prisma = null; }
const skip = prisma ? false : 'DATABASE_URL is not reachable';

describe('plan finish (database)', () => {
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('keeps the promise, tells the owner once when the work slips, and shows it and the tasks in «Входящие»', { skip }, async () => {
    const make = async (name: string) => {
      const email = `slip-${randomUUID()}@test.local`;
      const user = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name } });
      users.push(user.id);
      return user;
    };
    const owner = await make('Owner');
    const dev = await make('Dev');
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'Учёт заявок', startMode: 'build', status: 'active', projectType: 'web_app', locale: 'ru' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'owner', status: 'active' } });
    await prisma!.projectMember.create({ data: { projectId: project.id, userId: dev.id, role: 'contributor', status: 'active', stageKeys: ['roadmap'] } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'roadmap', position: 9, status: 'approved', definitionVersion: '1.0.0' } });
    const version = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: stage.id, versionNumber: 1, artifactType: 'roadmap', origin: 'owner_edit', content: plan as never, createdByUserId: owner.id } });
    await prisma!.projectStage.update({ where: { id: stage.id }, data: { approvedVersionId: version.id, currentVersionId: version.id } });

    const watch = new PlanScheduleService(prisma!);
    const monday = new Date('2026-11-30T09:00:00Z');
    // A plan accepted before the watch existed: today's forecast becomes the promise, nobody is told.
    assert.deepEqual(await watch.check(project.id, monday), { forecast: '2026-12-04', baseline: '2026-12-04', told: false });
    // Nothing done for two working days: the finish moves two days, the owner is told once.
    const wednesday = new Date('2026-12-02T09:00:00Z');
    assert.equal((await watch.check(project.id, wednesday))!.told, true);
    assert.equal((await watch.check(project.id, wednesday))!.told, false);
    const event = await prisma!.projectEvent.findFirstOrThrow({ where: { projectId: project.id, type: 'plan_finish_moved' } });
    assert.deepEqual({ ...(event.details as object) }, { baseline: '2026-12-04', from: '2026-12-04', to: '2026-12-08', workingDaysLate: 2, remainingCriticalHours: 16, lateTasks: [] });

    // «Входящие»: the owner sees the slip; the person a task was given to sees their task.
    await prisma!.planTaskState.create({ data: { projectId: project.id, taskKey: 'b1', status: 'in_progress', assigneeUserId: dev.id, dueDate: new Date('2026-12-03') } });
    const inbox = new InboxService(prisma!, null as never);
    const ownerItems = (await inbox.inbox(owner.id)).data.waiting.filter((item) => item.projectId === project.id);
    assert.deepEqual(ownerItems.map((item) => [item.kind, item.text]), [['plan_slip', '2026-12-04→2026-12-08']]);
    const devItems = (await inbox.inbox(dev.id)).data.waiting.filter((item) => item.projectId === project.id);
    assert.deepEqual(devItems.map((item) => [item.kind, item.count, item.text, item.dueAt?.slice(0, 10)]), [['plan_tasks', 1, 'Заявки', '2026-12-03']]);

    // The work catches up: the finish is back, the item goes; a new plan version makes a new promise.
    await prisma!.planTaskState.update({ where: { projectId_taskKey: { projectId: project.id, taskKey: 'b1' } }, data: { status: 'done' } });
    await prisma!.planTaskState.create({ data: { projectId: project.id, taskKey: 'a1', status: 'done' } });
    await watch.check(project.id, wednesday);
    assert.equal((await inbox.inbox(owner.id)).data.waiting.filter((item) => item.projectId === project.id && item.kind === 'plan_slip').length, 0);
    assert.equal((await inbox.inbox(dev.id)).data.waiting.filter((item) => item.projectId === project.id).length, 0);
  });
});
