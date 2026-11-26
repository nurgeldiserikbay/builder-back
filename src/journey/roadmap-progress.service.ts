import { MERGE_KIND } from '../agent/module-branch.js';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PlanScheduleService } from './plan-schedule.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { acceptRoles, inProject } from './journey-core.js';
import { JourneyCore } from './journey-core.js';
import { scheduleOf, type Roadmap, type RoadmapModule } from './roadmap.js';
import type { TestPlan } from './testplan.js';
import { workingDaysFrom } from './plan-schedule.js';

export const TASK_STATUSES = ['not_started', 'in_progress', 'review', 'done', 'done_with_note', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const finished = (status: TaskStatus) => status === 'done' || status === 'done_with_note';

/**
 * Progress of the accepted «План реализации» (PRODUCT_LIFECYCLE §4.8): the status, person and date of each task, the share
 * done by estimated hours (not by the number of items), what is blocked and by what, the expected finish of the critical
 * path, and the AI requests and specialist hours actually spent against the estimate.
 *
 * «Готово» needs green checks: every case of the accepted test plan (§4.10) linked to the task has passed. A task without
 * cases, or with a case not passed, can only be closed as «готово с замечанием» with a written reason — the same rule as
 * going on past a blocking review finding. The status is never set to done on anyone's word alone.
 */
@Injectable()
export class RoadmapProgressService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, @Optional() private readonly schedule?: PlanScheduleService) {}

  private async plan(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access, 'roadmap');
    if (!ctx.route.includes('roadmap')) throw new NotFoundException('STAGE_NOT_FOUND');
    const stage = this.core.stageOf(ctx, 'roadmap');
    if (!stage.approvedVersionId) throw new ConflictException('ROADMAP_NOT_APPROVED');
    const version = await this.core.versionContent(stage.approvedVersionId);
    if (!version) throw new ConflictException('ROADMAP_NOT_APPROVED');
    return { ctx, stage, plan: version.content as unknown as Roadmap, versionNumber: version.versionNumber };
  }

  /** Cases of the accepted test plan with their latest results; empty when there is no accepted test plan. */
  async cases(ctx: Awaited<ReturnType<JourneyCore['load']>>, projectId: string) {
    if (!ctx.route.includes('testplan')) return { plan: null, cases: [] as Array<TestPlan['cases'][number] & { result: { status: 'passed' | 'failed'; note: string | null; source: string; stale: boolean } | null }> };
    const stage = this.core.stageOf(ctx, 'testplan');
    const version = stage.approvedVersionId ? await this.core.versionContent(stage.approvedVersionId) : null;
    if (!version) return { plan: null, cases: [] };
    const plan = version.content as unknown as TestPlan;
    const rows = await this.prisma.planCaseResult.findMany({ where: { projectId } });
    return {
      plan: { versionNumber: version.versionNumber },
      cases: plan.cases.map((item) => {
        const row = rows.find((result) => result.caseKey === item.key);
        // A result recorded against an older plan version still shows, but a changed case has to be checked again.
        return { ...item, result: row ? { status: row.status, note: row.note, source: row.source, stale: row.planVersion !== version.versionNumber } : null };
      }),
    };
  }

  private checksOf(cases: Awaited<ReturnType<RoadmapProgressService['cases']>>['cases'], task: string) {
    const own = cases.filter((item) => item.task === task);
    return { total: own.length, passed: own.filter((item) => item.result?.status === 'passed' && !item.result.stale).length, failed: own.filter((item) => item.result?.status === 'failed').length };
  }

  async view(userId: string, projectId: string) {
    const { ctx, stage, plan, versionNumber } = await this.plan(userId, projectId, 'read');
    const { cases } = await this.cases(ctx, projectId);
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
          checks: this.checksOf(cases, task.key),
        };
      });
      const total = tasks.reduce((sum, task) => sum + task.hours, 0);
      const done = tasks.filter((task) => finished(task.status)).reduce((sum, task) => sum + task.hours, 0);
      return { key: module.key, name: module.name, executor: module.executor, dependsOn: module.dependsOn, critical: schedule?.criticalPath.includes(module.key) ?? false,
        progress: total ? Math.round((done / total) * 100) : 0, hoursDone: done, hoursTotal: total, tasks };
    };
    // The agent's latest task per module, so people see which module is being built and how it went.
    const agentRuns = await this.prisma.agentTask.findMany({ where: { projectId, moduleKey: { not: null }, kind: { not: MERGE_KIND } }, orderBy: { createdAt: 'desc' }, select: { id: true, moduleKey: true, status: true, createdAt: true, finishedAt: true }, take: 50 });
    // The owner's remarks on scenarios are tasks too: in the module of the case's task, without an estimate.
    const extras = rows.filter((row) => row.fromCaseKey);
    const homeOf = (row: (typeof rows)[number]) => (plan.modules.some((module) => module.key === row.moduleKey) ? row.moduleKey : plan.modules[0]?.key);
    const modules = plan.modules.map((module) => {
      const run = agentRuns.find((item) => item.moduleKey === module.key) ?? null;
      const view = moduleView({ ...module, tasks: [...module.tasks, ...extras.filter((row) => homeOf(row) === module.key).map((row) => ({ key: row.taskKey, title: row.title ?? row.taskKey, feature: null, release: 1, hours: 0, aiRequests: 0 }))] });
      return { ...view, tasks: view.tasks.map((task) => ({ ...task, fromCase: extras.find((row) => row.taskKey === task.key)?.fromCaseKey ?? null })), agent: run ? { taskId: run.id, status: run.status, startedAt: run.createdAt, finishedAt: run.finishedAt } : null };
    });
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
    const promise = await this.prisma.planSchedule.findUnique({ where: { projectId } });
    const hoursSpent = Math.round(entries.reduce((sum, entry) => sum + (entry.endedAt.getTime() - entry.startedAt.getTime()), 0) / 360_000) / 10;
    const all = modules.flatMap((module) => module.tasks.map((task) => ({ ...task, module: module.name, critical: module.critical })));
    const next = all.filter((task) => !finished(task.status) && task.status !== 'blocked').sort((a, b) => Number(b.critical) - Number(a.critical) || a.release - b.release)[0] ?? null;
    return {
      data: {
        versionNumber, hoursPerDay: plan.hoursPerDay, progress: total ? Math.round((done / total) * 100) : 0, hoursDone: done, hoursTotal: total,
        criticalPath: schedule?.criticalPath ?? [], expectedFinish: finish.toISOString().slice(0, 10), remainingCriticalHours: remainingCritical,
        // What the plan promised when it was accepted; null for a plan accepted before the promise was kept.
        promisedFinish: promise && promise.planVersion === versionNumber ? promise.baselineFinish.toISOString().slice(0, 10) : null,
        spent: { aiRequests: runs, specialistHours: hoursSpent }, planned: { aiRequests: schedule?.totalRequests ?? 0, hours: schedule?.totalHours ?? 0 },
        blocked: all.filter((task) => task.status === 'blocked').map((task) => ({ key: task.key, title: task.title, module: task.module, blockedBy: task.blockedBy })),
        late: all.filter((task) => task.late).map((task) => ({ key: task.key, title: task.title, module: task.module, dueDate: task.dueDate, critical: task.critical })),
        next: next ? { key: next.key, title: next.title, module: next.module } : null,
        modules, people, statuses: TASK_STATUSES, canEdit: this.core.canWrite(ctx, 'roadmap'),
        testPlanApproved: Boolean((await this.cases(ctx, projectId)).plan), agentRunning: agentRuns.some((item) => item.status === 'queued' || item.status === 'running'),
      },
    };
  }

  async update(userId: string, projectId: string, taskKey: string, input: { status?: unknown; note?: unknown; blockedBy?: unknown; assigneeUserId?: unknown; dueDate?: unknown }) {
    const { ctx, plan } = await this.plan(userId, projectId, 'write');
    const task = plan.modules.flatMap((module) => module.tasks).find((item) => item.key === taskKey)
      ?? (await this.prisma.planTaskState.findFirst({ where: { projectId, taskKey, fromCaseKey: { not: null } } }));
    if (!task) throw new NotFoundException('TASK_NOT_FOUND');
    const current = await this.prisma.planTaskState.findUnique({ where: { projectId_taskKey: { projectId, taskKey } } });
    const status = (input.status === undefined ? current?.status ?? 'not_started' : input.status) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException('TASK_STATUS_INVALID');
    const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : null) || null;
    const note = input.note === undefined ? current?.note ?? null : clean(input.note, 500);
    const blockedBy = input.blockedBy === undefined ? current?.blockedBy ?? null : clean(input.blockedBy, 300);
    // A task is done when its checks pass; without checks it can only be closed with a written reason.
    if (status === 'done') {
      const checks = this.checksOf((await this.cases(ctx, projectId)).cases, taskKey);
      if (!checks.total) throw new ConflictException('TASK_NEEDS_CHECKS');
      if (checks.passed < checks.total) throw new ConflictException('TASK_CHECKS_NOT_PASSED');
    }
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
    // A changed date or a blocked task can move the finish: worked out again now, not at the next hourly round.
    await this.schedule?.check(projectId).catch(() => null);
    return this.view(userId, projectId);
  }

  /**
   * A person records the result of a case checked by hand or in a browser. Automatic cases get results only from test
   * runs: a person cannot mark them passed.
   */
  async recordCase(userId: string, projectId: string, caseKey: string, input: { status?: unknown; note?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'write', 'testplan');
    const { plan, cases } = await this.cases(ctx, projectId);
    if (!plan) throw new ConflictException('TESTPLAN_NOT_APPROVED');
    const item = cases.find((one) => one.key === caseKey);
    if (!item) throw new NotFoundException('CASE_NOT_FOUND');
    if (item.method === 'auto') throw new ConflictException('CASE_AUTOMATIC');
    const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500) || null : null;
    if (input.status === 'not_run') await this.prisma.planCaseResult.deleteMany({ where: { projectId, caseKey } });
    else {
      if (input.status !== 'passed' && input.status !== 'failed') throw new BadRequestException('CASE_STATUS_INVALID');
      if (input.status === 'failed' && (!note || note.length < 10)) throw new BadRequestException('CASE_NOTE_REQUIRED');
      const data = { status: input.status as 'passed' | 'failed', note, planVersion: plan.versionNumber, byUserId: userId };
      await this.prisma.planCaseResult.upsert({ where: { projectId_caseKey: { projectId, caseKey } }, create: { projectId, caseKey, ...data }, update: data });
    }
    await this.core.event(this.prisma, projectId, userId, 'test_case_result', 'testplan', { caseKey, status: input.status, ...(note ? { note } : {}) });
    return { data: { cases: (await this.cases(ctx, projectId)).cases.map((one) => ({ key: one.key, result: one.result })) } };
  }

  /**
   * «Приёмка владельцем» (§4.10): the owner tries a main scenario — normal path or mistakes — on the test version and says
   * it works, does not work, or works with a remark. Not working and a remark become a task of the plan in the module of the
   * case's task; «работает» later closes it — the owner's own confirmation is what that task waited for.
   */
  async acceptScenario(userId: string, projectId: string, caseKey: string, input: { verdict?: unknown; note?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'accept', 'testplan');
    const { plan, cases } = await this.cases(ctx, projectId);
    if (!plan) throw new ConflictException('TESTPLAN_NOT_APPROVED');
    const item = cases.find((one) => one.key === caseKey);
    if (!item) throw new NotFoundException('CASE_NOT_FOUND');
    if (item.class !== 'normal' && item.class !== 'mistakes') throw new BadRequestException('CASE_NOT_MAIN_SCENARIO');
    const verdict = input.verdict;
    if (verdict !== 'works' && verdict !== 'broken' && verdict !== 'remark') throw new BadRequestException('ACCEPTANCE_VERDICT_INVALID');
    const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500) || null : null;
    if (verdict !== 'works' && (!note || note.length < 10)) throw new BadRequestException('ACCEPTANCE_NOTE_REQUIRED');
    const roadmapStage = ctx.route.includes('roadmap') ? this.core.stageOf(ctx, 'roadmap') : null;
    const roadmap = roadmapStage?.approvedVersionId ? (await this.core.versionContent(roadmapStage.approvedVersionId))?.content as unknown as Roadmap | undefined : undefined;
    const moduleKey = roadmap?.modules.find((module) => module.tasks.some((task) => task.key === item.task))?.key ?? null;
    const fixKey = `fix_${caseKey}`.slice(0, 32);
    await this.prisma.$transaction(async (tx) => {
      const data = { verdict: verdict as 'works' | 'broken' | 'remark', note, planVersion: plan.versionNumber, byUserId: userId };
      await tx.planCaseAcceptance.upsert({ where: { projectId_caseKey: { projectId, caseKey } }, create: { projectId, caseKey, ...data }, update: data });
      const fix = await tx.planTaskState.findUnique({ where: { projectId_taskKey: { projectId, taskKey: fixKey } } });
      if (verdict === 'works') {
        if (fix && !finished(fix.status as TaskStatus)) await tx.planTaskState.update({ where: { id: fix.id }, data: { status: 'done', blockedBy: null, updatedByUserId: userId } });
      } else if (roadmap) {
        const title = inProject(ctx, () => tr(verdict === 'broken' ? 'Не работает: {0}. Сценарий: {1}' : 'Замечание: {0}. Сценарий: {1}', [note!.replace(/[.。]$/, ''), item.title])).slice(0, 200);
        const reopen = fix && finished(fix.status as TaskStatus);
        await tx.planTaskState.upsert({ where: { projectId_taskKey: { projectId, taskKey: fixKey } },
          create: { projectId, taskKey: fixKey, title, moduleKey, fromCaseKey: caseKey, status: 'not_started', updatedByUserId: userId },
          update: { title, moduleKey, ...(reopen ? { status: 'in_progress' } : {}), updatedByUserId: userId } });
      }
      await this.core.event(tx, projectId, userId, 'scenario_accepted', 'testplan', { caseKey, verdict, ...(note ? { note } : {}) });
    });
    return { data: { ...(await this.acceptanceSummary(ctx, projectId)), canAccept: true } };
  }

  async acceptance(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read', 'testplan');
    return { data: { ...(await this.acceptanceSummary(ctx, projectId)), canAccept: ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role) } };
  }

  /** The owner's verdicts and what stands between the project and a launch, by the test plan's own rule (§4.10 «Готово, когда»). */
  async acceptanceSummary(ctx: Awaited<ReturnType<JourneyCore['load']>>, projectId: string) {
    const { plan, cases } = await this.cases(ctx, projectId);
    const rows = plan ? await this.prisma.planCaseAcceptance.findMany({ where: { projectId } }) : [];
    const fixes = plan ? await this.prisma.planTaskState.findMany({ where: { projectId, fromCaseKey: { not: null } }, select: { taskKey: true, status: true, fromCaseKey: true } }) : [];
    const main = cases.filter((item) => item.class === 'normal' || item.class === 'mistakes');
    const verdictOf = (key: string) => {
      const row = rows.find((one) => one.caseKey === key);
      return row ? { verdict: row.verdict, note: row.note, stale: row.planVersion !== plan!.versionNumber } : null;
    };
    const blocking = cases.filter((item) => item.blocking);
    const openFixes = fixes.filter((row) => !finished(row.status as TaskStatus));
    return {
      acceptances: main.map((item) => ({ caseKey: item.key, ...(verdictOf(item.key) ?? { verdict: null, note: null, stale: false }) })),
      readiness: {
        blocking: { total: blocking.length, passed: blocking.filter((item) => item.result?.status === 'passed' && !item.result.stale).length },
        scenarios: { total: main.length, works: main.filter((item) => { const v = verdictOf(item.key); return v && !v.stale && v.verdict !== 'broken'; }).length },
        openRemarks: openFixes.length,
      },
    };
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
export { workingDaysFrom } from './plan-schedule.js';
