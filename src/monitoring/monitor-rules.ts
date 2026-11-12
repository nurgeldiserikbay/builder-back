// When a published site counts as down, when the owner is told, and when the weekly report is due.

/** Two failed checks in a row (about 20 minutes) — a single timeout is not worth waking anyone up. */
export const FAILURES_FOR_DOWN = 2;
export const CHECK_INTERVAL_MS = 10 * 60_000;

export type MonitorStatus = 'unknown' | 'up' | 'down';
export interface MonitorState { status: MonitorStatus; failures: number; downSince: Date | null; alertedAt: Date | null }
export interface Probe { ok: boolean; status: number | null; ms: number; error: string | null }

/** The state after one check and what to tell the owner. */
export function nextState(state: MonitorState, probe: Probe, now = new Date()): { state: MonitorState; alert: 'down' | 'recovered' | null; incident: 'open' | 'close' | null } {
  if (probe.ok) {
    const wasDown = state.status === 'down';
    return {
      state: { status: 'up', failures: 0, downSince: null, alertedAt: null },
      alert: wasDown && state.alertedAt ? 'recovered' : null,
      incident: wasDown ? 'close' : null,
    };
  }
  const failures = state.failures + 1;
  if (failures < FAILURES_FOR_DOWN) return { state: { ...state, failures }, alert: null, incident: null };
  if (state.status === 'down') return { state: { ...state, failures }, alert: null, incident: null };
  // It went down at the first failed check of this run, not at the one that confirmed it.
  const downSince = new Date(now.getTime() - (failures - 1) * CHECK_INTERVAL_MS);
  return { state: { status: 'down', failures, downSince, alertedAt: now }, alert: 'down', incident: 'open' };
}

/** A check is fine when the site answers with a page (2xx) or a redirect (3xx) in time. */
export function probeOk(status: number | null): boolean {
  return status !== null && status >= 200 && status < 400;
}

/** Monday of the week the date falls in, at 00:00 in the given zone, as YYYY-MM-DD. */
export function weekStart(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!);
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  return new Date(day.getTime() - weekday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The weekly report goes once per week from Monday 9:00 in the zone. If the server was off on Monday morning, it goes
 * at the first chance later that week rather than being skipped.
 */
export function weeklyReportDue(timeZone: string, lastSentWeek: string | null, now = new Date()): { due: boolean; week: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]));
  const week = weekStart(timeZone, now);
  const earlyMonday = parts.weekday === 'Mon' && Number(parts.hour) < 9;
  return { due: !earlyMonday && lastSentWeek !== week, week };
}

/** «1 ч 20 мин» for downtime in a message. */
export function duration(ms: number): { hours: number; minutes: number } {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
