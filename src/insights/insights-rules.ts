// How the «after launch» summary is put together from daily counts.

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

export function periodOf(value: unknown): Period {
  const days = Number(value);
  return (PERIODS as readonly number[]).includes(days) ? (days as Period) : 30;
}

/** Every day of the period, oldest first, with zero where nothing was counted — so a chart has no gaps. */
export function fillDays(rows: Array<{ day: string; views: number }>, lastDay: string, days: number): Array<{ day: string; views: number }> {
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.views);
  const end = new Date(`${lastDay}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(end.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, views: byDay.get(day) ?? 0 };
  });
}

/** Change against the previous period of the same length, in whole percent; null when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Largest first; the rest is summed up as «other» so the list stays short on a phone. */
export function top<T extends { views: number }>(rows: T[], limit: number, other: (views: number) => T): T[] {
  const sorted = [...rows].sort((a, b) => b.views - a.views);
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit).reduce((sum, row) => sum + row.views, 0);
  return [...sorted.slice(0, limit), other(rest)];
}

/** Leads per hundred page views, one decimal; null without views. */
export function conversion(leads: number, views: number): number | null {
  return views > 0 ? Math.round((leads / views) * 1000) / 10 : null;
}
