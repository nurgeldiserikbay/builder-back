import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from './journey-core.js';
import { scheduleOf, type Roadmap, type RoadmapModule } from './roadmap.js';

export const TASK_STATUSES = ['not_started', 'in_progress', 'review', 'done', 'done_with_note', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const finished = (status: TaskStatus) => status === 'done' || status === 'done_with_note';

/**
 * Progress of the accepted «План реализации» (PRODUCT_LIFECYCLE §4.8): the status, person and date of each task, the share
 * done by estimated hours (not by the number of items), what is blocked and by what, the expected finish of the critical
 * path, and the AI requests and specialist hours actually spent against the estimate.
 *
 * «Готово» needs green checks of the task. Until the test plan (§4.10) gives tasks their checks, no task has any, so
 * `done` is refused and only «готово с замечанием» with a written reason closes a task — the same rule as going on past
 * a blocking review finding. The status is never set to done on anyone's word alone.
 */
@Injectable()
export class RoadmapProgressService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  private async plan(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access, 'roadmap');
    if (!ctx.route.includes('roadmap')) throw new NotFoundException('STAGE_NOT_FOUND');
    const stage = this.core.stageOf(ctx, 'roadmap');
    if (!stage.approvedVersionId) throw new ConflictException('ROADMAP_NOT_APPROVED');
    const version = await this.core.versionContent(stage.approvedVersionId);
    if (!version) throw new ConflictException('ROADMAP_NOT_APPROVED');
    return { ctx, stage, plan: version.content as unknown as Roadmap, versionNumber: version.versionNumber };
  }

  async view(userId: string, projectId: string) {
    const { ctx, stage, plan, versionNumber } = await this.plan(userId, projectId, 'read');
    const rows = await this.prisma.planTaskState.findMany({ where: { projectId } });
    const people = await this.people(projectId);
    const today = new Date(new Date().toISOString().slice(0, 10));
    const stateOf = (key: string) => rows.find((row) => row.taskKey === key) ?? null;
    const schedule = scheduleOf(plan);
    const moduleView = (module: RoadmapModule) => {
      const tasks = module.tasks.map((task) => {
        const row = stateOf(task.key);
        const status = (row?.status ?? 'not_started') as TaskStatus;
        return {
          key: task.key, title: task.title, feature: task.feature, release: task.release, hours: task.hours, aiRequests: task.aiRequests,
          status, assigneeUserId: row?.assigneeUserId ?? null, assignee: people.find((person) => person.userId === row?.assigneeUserId)?.name ?? null,
          dueDate: row?.dueDate ? row.dueDate.toISOString().slice(0, 10) : null, note: row?.note ?? null, blockedBy: row?.blockedBy ?? null,
          late: Boolean(row?.dueDate && row.dueDate < today && !finished(status)),
          // No task has checks yet: the test plan gives them. Shown so nobody reads «готово с замечанием» as tested.
          checks: { total: 0, passed: 0 },
        };
      });
      const total = tasks.reduce((sum, task) => sum + task.hours, 0);
      const done = tasks.filter((task) => finished(task.status)).reduce((sum, task) => sum + task.hours, 0);
      return { key: module.key, name: module.name, executor: module.executor, dependsOn: module.dependsOn, critical: schedule?.criticalPath.includes(module.key) ?? false,
        progress: total ? Math.round((done / total) * 100) : 0, hoursDone: done, hoursTotal: total, tasks };
    };
    const modules = plan.modules.map(moduleView);
    const total = modules.reduce((sum, module) => sum + module.hoursTotal, 0);
    const done = modules.reduce((sum, module) => sum + module.hoursDone, 0);
    // What is left on the critical path decides the finish: remaining hours of its unfinished tasks, from today.
    const remainingCritical = modules.filter((module) => module.critical).reduce((sum, module) => sum + module.tasks.filter((task) => !finished(task.status)).reduce((s, task) => s + task.hours, 0), 0);
    const finish = workingDaysFrom(today, Math.ceil(remainingCritical / plan.hoursPerDay));
    const since = stage.approvedAt ?? new Date(0);
    const [runs, entries] = await Promise.all([
      this.prisma.generationRun.count({ where: { projectId, createdAt: { gte: since }, provider: { not: 'template' } } }),
      this.prisma.timeEntry.findMany({ where: { projectId, startedAt: { gte: since }, status: { not: 'disputed' } }, select: { startedAt: true, endedAt: true } }),
    ]);
    const hoursSpent = Math.round(entries.reduce((sum, entry) => sum + (entry.endedAt.getTime() - entry.startedAt.getTime()), 0) / 360_000) / 10;
    const all = modules.flatMap((module) => module.tasks.map((task) => ({ ...task, module: module.name, critical: module.critical })));
    const next = all.filter((task) => !finished(task.status) && task.status !== 'blocked').sort((a, b) => Number(b.critical) - Number(a.critical) || a.release - b.release)[0] ?? null;
    return {
      data: {
        versionNumber, hoursPerDay: plan.hoursPerDay, progress: total ? Math.round((done / total) * 100) : 0, hoursDone: done, hoursTotal: total,
        criticalPath: schedule?.criticalPath ?? [], expectedFinish: finish.toISOString().slice(0, 10), remainingCriticalHours: remainingCritical,
        spent: { aiRequests: runs, specialistHours: hoursSpent }, planned: { aiRequests: schedule?.totalRequests ?? 0, hours: schedule?.totalHours ?? 0 },
        blocked: all.filter((task) => task.status === 'blocked').map((task) => ({ key: task.key, title: task.title, module: task.module, blockedBy: task.blockedBy })),
        late: all.filter((task) => task.late).map((task) => ({ key: task.key, title: task.title, module: task.module, dueDate: task.dueDate, critical: task.critical })),
        next: next ? { key: next.key, title: next.title, module: next.module } : null,
        modules, people, statuses: TASK_STATUSES, canEdit: this.core.canWrite(ctx, 'roadmap'),
      },
    };
  }

  async update(userId: string, projectId: string, taskKey: string, input: { status?: unknown; note?: unknown; blockedBy?: unknown; assigneeUserId?: unknown; dueDate?: unknown }) {
    const { plan } = await this.plan(userId, projectId, 'write');
    const task = plan.modules.flatMap((module) => module.tasks).find((item) => item.key === taskKey);
    if (!task) throw new NotFoundException('TASK_NOT_FOUND');
    const current = await this.prisma.planTaskState.findUnique({ where: { projectId_taskKey: { projectId, taskKey } } });
    const status = (input.status === undefined ? current?.status ?? 'not_started' : input.status) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException('TASK_STATUS_INVALID');
    const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : null) || null;
    const note = input.note === undefined ? current?.note ?? null : clean(input.note, 500);
    const blockedBy = input.blockedBy === undefined ? current?.blockedBy ?? null : clean(input.blockedBy, 300);
    // A task is done when its checks pass; without checks it can only be closed with a written reason.
    if (status === 'done') throw new ConflictException('TASK_NEEDS_CHECKS');
    if (status === 'done_with_note' && (!note || note.length < 10)) throw new BadRequestException('TASK_NOTE_REQUIRED');
    if (status === 'blocked' && !blockedBy) throw new BadRequestException('TASK_BLOCKER_REQUIRED');
    let assigneeUserId = current?.assigneeUserId ?? null;
    if (input.assigneeUserId !== undefined) {
      assigneeUserId = typeof input.assigneeUserId === 'string' && input.assigneeUserId ? input.assigneeUserId : null;
      if (assigneeUserId && !(await this.people(projectId)).some((person) => person.userId === assigneeUserId)) throw new BadRequestException('TASK_ASSIGNEE_NOT_IN_PROJECT');
    }
    let dueDate = current?.dueDate ?? null;
    if (input.dueDate !== undefined) {
      if (input.dueDate === null || input.dueDate === '') dueDate = null;
      else if (typeof input.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) && !Number.isNaN(Date.parse(input.dueDate))) dueDate = new Date(input.dueDate);
      else throw new BadRequestException('TASK_DUE_DATE_INVALID');
    }
    const data = { status, note, blockedBy: status === 'blocked' ? blockedBy : null, assigneeUserId, dueDate, updatedByUserId: userId };
    await this.prisma.$transaction(async (tx) => {
      await tx.planTaskState.upsert({ where: { projectId_taskKey: { projectId, taskKey } }, create: { projectId, taskKey, ...data }, update: data });
      if ((current?.status ?? 'not_started') !== status) await this.core.event(tx, projectId, userId, 'plan_task_status', 'roadmap', { taskKey, from: current?.status ?? 'not_started', to: status, ...(status === 'done_with_note' ? { note } : {}) });
    });
    return this.view(userId, projectId);
  }

  /** Who can take a task: active members and specialists assigned to stages of this project. */
  private async people(projectId: string) {
    const [members, assignments] = await Promise.all([
      this.prisma.projectMember.findMany({ where: { projectId, status: 'active' }, select: { userId: true, user: { select: { name: true, email: true } } } }),
      this.prisma.stageAssignment.findMany({ where: { projectId, status: 'active', userId: { not: null } }, select: { userId: true, user: { select: { name: true, email: true } } } }),
    ]);
    const out = new Map<string, { userId: string; name: string }>();
    for (const row of [...members, ...assignments]) if (row.userId && row.user) out.set(row.userId, { userId: row.userId, name: row.user.name || row.user.email });
    return [...out.values()];
  }
}

/** A date `days` working days (Monday–Friday) after `from`. */
export function workingDaysFrom(from: Date, days: number): Date {
  const date = new Date(from);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date;
}
