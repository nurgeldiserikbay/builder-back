// Success goals of the idea review (builder-docs PRODUCT_LIFECYCLE.md §4.2, §4.12) measured by the usage counters. The
// goals stay the owner's words in the idea review; here the owner says how each one is counted — visitors, screen views or
// one main action — with a number for a week or a month, and the growth tab shows how far the last 7 or 30 days got.
import { BadRequestException } from '@nestjs/common';
import { tr } from '../i18n/i18n.js';
import { cleanAction } from './usage.service.js';

export type GoalKind = 'visitors' | 'views' | 'action';
export type GoalPeriod = 'week' | 'month';
export interface UsageGoal { metricKey: string; kind: GoalKind; name: string | null; target: number; period: GoalPeriod }

export const GOAL_LIMITS = { goals: 3, target: 10_000_000 };
const KINDS: GoalKind[] = ['visitors', 'views', 'action'];
const PERIODS: GoalPeriod[] = ['week', 'month'];

/** The goals as the owner sends them, checked against the idea review's goals: unknown ones are refused. */
export function readGoals(raw: unknown, metricKeys: string[]): UsageGoal[] {
  if (!Array.isArray(raw) || raw.length > GOAL_LIMITS.goals) throw new BadRequestException('INVALID_GOALS');
  const seen = new Set<string>();
  return raw.map((item) => {
    const goal = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const metricKey = typeof goal.metricKey === 'string' ? goal.metricKey : '';
    if (!metricKeys.includes(metricKey) || seen.has(metricKey)) throw new BadRequestException('INVALID_GOALS');
    seen.add(metricKey);
    const kind = KINDS.find((value) => value === goal.kind);
    const period = PERIODS.find((value) => value === goal.period);
    const target = Number(goal.target);
    if (!kind || !period || !Number.isInteger(target) || target < 1 || target > GOAL_LIMITS.target) throw new BadRequestException('INVALID_GOALS');
    const name = kind === 'action' ? cleanAction(goal.name) : null;
    if (kind === 'action' && !name) throw new BadRequestException('INVALID_GOALS');
    return { metricKey, kind, name, target, period };
  });
}

/** What the goal's own words suggest: the first number and «в неделю» / «в месяц». Only a hint — the owner confirms it. */
export function goalHint(text: string): { target: number | null; period: GoalPeriod | null; kind: GoalKind | null } {
  const number = text.replace(/(\d)[\s ](?=\d{3}\b)/g, '$1').match(/\d+/);
  const lower = text.toLowerCase();
  const period: GoalPeriod | null = /недел|week/.test(lower) ? 'week' : /месяц|мес\b|month/.test(lower) ? 'month' : null;
  const kind: GoalKind | null = /посетител|пользовател|человек|клиент|visitor|user|people/.test(lower) ? 'visitors' : /заяв|заказ|запис|оплат|покуп|request|order|booking/.test(lower) ? 'action' : null;
  const target = number ? Number(number[0]) : null;
  return { target: target && target <= GOAL_LIMITS.target ? target : null, period, kind };
}

type Row = { day: Date; kind: string; name: string; count: number };

/**
 * Progress of each goal: the count over the last 7 days for a weekly goal and the last 30 for a monthly one, whatever
 * period the report shows. reached — the count is at the target; behind — not yet; no_data — nothing counted yet.
 */
export function goalProgress(goals: UsageGoal[], metrics: Array<{ key: string; text: string }>, rows: Row[], today: Date, counted: boolean) {
  const since = (days: number) => new Date(today.getTime() - (days - 1) * 86_400_000);
  return metrics.map((metric) => {
    const goal = goals.find((item) => item.metricKey === metric.key) ?? null;
    if (!goal) return { metricKey: metric.key, text: metric.text, goal: null, hint: goalHint(metric.text), actual: null, percent: null, status: 'not_set' as const };
    const from = since(goal.period === 'week' ? 7 : 30);
    const kind = goal.kind === 'views' ? 'view' : goal.kind;
    const actual = rows.filter((row) => row.kind === kind && row.day >= from && (goal.kind !== 'action' || row.name === goal.name)).reduce((sum, row) => sum + row.count, 0);
    const status = !counted ? 'no_data' as const : actual >= goal.target ? 'reached' as const : 'behind' as const;
    return { metricKey: metric.key, text: metric.text, goal, hint: null, actual, percent: Math.min(100, Math.round((actual / goal.target) * 100)), status };
  });
}

export const goalKindLabels = (): Record<GoalKind, string> => ({ visitors: tr('Посетители'), views: tr('Открытия экранов'), action: tr('Главное действие') });
