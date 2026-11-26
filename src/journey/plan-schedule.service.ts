import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { currentLocale, tr } from '../i18n/i18n.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { editableProject } from './journey-core.js';
import { dayOf, planForecast, shouldTell, workingDaysBetween } from './plan-schedule.js';
import type { Roadmap } from './roadmap.js';

type Db = Pick<Prisma.TransactionClient, 'planSchedule' | 'planTaskState' | 'projectEvent'>;
const HOUR = 3_600_000;
const day = (date: Date) => date.toISOString().slice(0, 10);

/** The promise of a just-accepted plan version: its finish from today, with the tasks as they stand. */
export async function setPlanBaseline(db: Db, input: { projectId: string; plan: Roadmap; planVersion: number; today?: Date }) {
  const states = await db.planTaskState.findMany({ where: { projectId: input.projectId }, select: { taskKey: true, status: true, dueDate: true } });
  const finish = planForecast(input.plan, states, input.today ?? new Date()).finish;
  const data = { planVersion: input.planVersion, baselineFinish: finish, forecastFinish: finish, notifiedFinish: null, checkedAt: new Date() };
  await db.planSchedule.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId, ...data }, update: data });
}

/**
 * The finish of an application's accepted implementation plan, watched (PRODUCT_LIFECYCLE §4.8). Accepting a plan fixes
 * its promised finish. Then, hourly and after every change of a task, the finish the work points to is worked out again;
 * when it moves later by two working days or more than what people were last told, the owner and the managers are told,
 * with why — what is left on the critical path and which of its tasks are late.
 */
@Injectable()
export class PlanScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.PLAN_SCHEDULE_WATCH === 'off') return;
    this.timer = setInterval(() => { void this.checkAll().catch((error: unknown) => this.logger.warn(`Plan schedule check failed: ${(error as Error).name}`)); }, HOUR);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async setBaseline(db: Db, input: { projectId: string; plan: Roadmap; planVersion: number; today?: Date }) {
    await setPlanBaseline(db, input);
  }

  /**
   * Works out the finish again and tells people when it moved enough. A project whose plan was accepted before this watch
   * existed gets today's forecast as its promise, without a message.
   */
  async check(projectId: string, today = new Date()): Promise<{ forecast: string; baseline: string; told: boolean } | null> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true, projectType: true, ownerUserId: true } });
    if (!project || project.projectType !== 'web_app' || !editableProject(project.status)) return null;
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'roadmap' }, select: { approvedVersionId: true } });
    if (!stage?.approvedVersionId) return null;
    const version = await this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.approvedVersionId }, select: { versionNumber: true, content: true } });
    const plan = version?.content as Roadmap | undefined;
    if (!version || !plan?.modules) return null;
    const row = await this.prisma.planSchedule.findUnique({ where: { projectId } });
    if (!row || row.planVersion !== version.versionNumber) {
      await this.setBaseline(this.prisma, { projectId, plan, planVersion: version.versionNumber, today });
      const finish = (await this.prisma.planSchedule.findUniqueOrThrow({ where: { projectId } })).baselineFinish;
      return { forecast: day(finish), baseline: day(finish), told: false };
    }
    const states = await this.prisma.planTaskState.findMany({ where: { projectId }, select: { taskKey: true, status: true, dueDate: true } });
    // Everything done: nothing can be late any more.
    if (states.length && plan.modules.flatMap((module) => module.tasks).every((task) => ['done', 'done_with_note'].includes(states.find((state) => state.taskKey === task.key)?.status ?? ''))) {
      await this.prisma.planSchedule.update({ where: { projectId }, data: { forecastFinish: dayOf(today), notifiedFinish: null, checkedAt: new Date() } });
      return { forecast: day(dayOf(today)), baseline: day(row.baselineFinish), told: false };
    }
    const forecast = planForecast(plan, states, today);
    const tell = shouldTell({ baseline: row.baselineFinish, notified: row.notifiedFinish, forecast: forecast.finish });
    // Back on time: a later slip is news again.
    const notifiedFinish = tell ? forecast.finish : forecast.finish <= row.baselineFinish ? null : row.notifiedFinish;
    const moved = await this.prisma.planSchedule.updateMany({
      where: { projectId, planVersion: row.planVersion, notifiedFinish: row.notifiedFinish },
      data: { forecastFinish: forecast.finish, notifiedFinish, checkedAt: new Date() },
    });
    if (!tell || moved.count !== 1) return { forecast: day(forecast.finish), baseline: day(row.baselineFinish), told: false };
    const late = workingDaysBetween(row.baselineFinish, forecast.finish);
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: null, type: 'plan_finish_moved', stageKey: 'roadmap', details: { baseline: day(row.baselineFinish), from: day(row.notifiedFinish ?? row.baselineFinish), to: day(forecast.finish), workingDaysLate: late, remainingCriticalHours: forecast.remainingCriticalHours, lateTasks: forecast.lateCritical.map((task) => task.key) } } });
    const managers = await this.prisma.projectMember.findMany({ where: { projectId, role: 'manager' }, select: { userId: true } });
    const link = process.env.PUBLIC_APP_URL ? new URL(`/projects/${projectId}/stages/roadmap`, process.env.PUBLIC_APP_URL).toString() : '';
    // In the reader's language: the text is built when it is sent to each person.
    const fmt = (date: Date) => date.toLocaleDateString(currentLocale() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    for (const userId of new Set([project.ownerUserId, ...managers.map((member) => member.userId)])) {
      await notifyUser(this.prisma, userId, {
        category: 'stages',
        emailSubject: () => tr('BuildPath: срок проекта «{0}» сдвигается', [project.name]),
        link: { path: `/projects/${projectId}/stages/roadmap`, label: () => tr('Открыть план') },
        text: () => [
          tr('Срок проекта «{0}» сдвигается: по плану — {1}, сейчас выходит {2} (на {3} раб. дн. позже).', [project.name, fmt(row.baselineFinish), fmt(forecast.finish), late]),
          tr('На критическом пути осталось {0} ч.', [forecast.remainingCriticalHours]),
          forecast.lateCritical.length ? tr('Опаздывают задачи: {0}.', [forecast.lateCritical.slice(0, 5).map((task) => task.title).join('; ')]) : '',
          tr('Решите, что делать: добавить людей или ИИ-агента на модули критического пути, перенести часть функций в следующий выпуск или согласиться с новым сроком.'),
          link,
        ].filter(Boolean).join('\n'),
      });
    }
    return { forecast: day(forecast.finish), baseline: day(row.baselineFinish), told: true };
  }

  /** Every application with an accepted plan; one failing project does not stop the rest. */
  async checkAll(today = new Date()): Promise<number> {
    const rows = await this.prisma.projectStage.findMany({ where: { stageKey: 'roadmap', approvedVersionId: { not: null }, project: { projectType: 'web_app', status: { in: ['active', 'live'] } } }, select: { projectId: true }, take: 2000 });
    let told = 0;
    for (const row of rows) {
      try { if ((await this.check(row.projectId, today))?.told) told += 1; } catch (error) { this.logger.warn(`Plan schedule of ${row.projectId}: ${(error as Error).name}`); }
    }
    return told;
  }
}
