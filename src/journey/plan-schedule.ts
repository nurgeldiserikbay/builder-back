// When an application's implementation plan will be done (PRODUCT_LIFECYCLE §4.8): pure arithmetic over the accepted plan
// and its tasks' states. The finish follows the critical path: its unfinished hours at the plan's hours per day, from today.
import { scheduleOf, type Roadmap } from './roadmap.js';

/** The finish moved this many working days later than what people were last told: they are told again. */
export const SLIP_NOTIFY_DAYS = 2;

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

/** Working days from a to b (negative when b is earlier); weekends do not count. */
export function workingDaysBetween(a: Date, b: Date): number {
  const sign = b >= a ? 1 : -1;
  const [from, to] = sign > 0 ? [a, b] : [b, a];
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let count = 0;
  while (date.getTime() < end) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return sign * count;
}

export const dayOf = (date: Date) => new Date(date.toISOString().slice(0, 10));
const finished = (status: string) => status === 'done' || status === 'done_with_note';

export interface PlanForecast {
  finish: Date;
  remainingCriticalHours: number;
  /** Unfinished tasks of the critical path whose own date has passed: the usual reason the finish moves. */
  lateCritical: Array<{ key: string; title: string; dueDate: string }>;
}

export function planForecast(plan: Roadmap, states: Array<{ taskKey: string; status: string; dueDate: Date | null }>, today: Date): PlanForecast {
  const critical = new Set(scheduleOf(plan)?.criticalPath ?? []);
  const state = (key: string) => states.find((row) => row.taskKey === key);
  const open = plan.modules.filter((module) => critical.has(module.key)).flatMap((module) => module.tasks).filter((task) => !finished(state(task.key)?.status ?? 'not_started'));
  const remainingCriticalHours = open.reduce((sum, task) => sum + task.hours, 0);
  const day = dayOf(today);
  return {
    finish: workingDaysFrom(day, Math.ceil(remainingCriticalHours / Math.max(1, plan.hoursPerDay))),
    remainingCriticalHours,
    lateCritical: open.flatMap((task) => {
      const due = state(task.key)?.dueDate;
      return due && due < day ? [{ key: task.key, title: task.title, dueDate: due.toISOString().slice(0, 10) }] : [];
    }),
  };
}

/** Whether people are told now: the finish is later than both the promise and what they were last told, by enough. */
export function shouldTell(input: { baseline: Date; notified: Date | null; forecast: Date }): boolean {
  const reference = input.notified && input.notified > input.baseline ? input.notified : input.baseline;
  return workingDaysBetween(reference, input.forecast) >= SLIP_NOTIFY_DAYS;
}
