// Pure rules for specialist time and money (STAGE_WORK_MODEL, section 29). Amounts in tiyn, time in minutes.

export const IDLE_MS = 5 * 60 * 1000;
export const AUTO_APPROVE_MS = 3 * 24 * 60 * 60 * 1000;
export const WARN_SHARE = 0.8;

export type Terms = { payKind: string; fixedAmountTiyn: number | null; hourlyRateTiyn: number | null; hourLimit: number | null; onlyResultTime: boolean };
export type Entry = { startedAt: Date; endedAt: Date; source: string; actions: number; status: string; createdAt: Date };

export function minutesOf(entry: Pick<Entry, 'startedAt' | 'endedAt'>): number {
  return Math.max(1, Math.ceil((entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000));
}

/** Entries nobody disputed within 3 days count as approved. */
export function effectiveStatus(entry: Pick<Entry, 'status' | 'createdAt'>, now: Date): string {
  return entry.status === 'pending' && now.getTime() - entry.createdAt.getTime() > AUTO_APPROVE_MS ? 'auto_approved' : entry.status;
}

export const withoutResult = (entry: Pick<Entry, 'source' | 'actions'>) => entry.source === 'tracked' && entry.actions === 0;

export function summarize(entries: Entry[], terms: Terms, now: Date) {
  let tracked = 0, approved = 0, pending = 0, disputed = 0, noResult = 0, eligible = 0;
  for (const entry of entries) {
    const minutes = minutesOf(entry);
    const status = effectiveStatus(entry, now);
    tracked += minutes;
    if (withoutResult(entry)) noResult += minutes;
    if (status === 'approved' || status === 'auto_approved') {
      approved += minutes;
      if (!(terms.onlyResultTime && withoutResult(entry))) eligible += minutes;
    } else if (status === 'disputed') disputed += minutes;
    else pending += minutes;
  }
  const limit = terms.hourLimit ? terms.hourLimit * 60 : null;
  const payable = limit === null ? eligible : Math.min(eligible, limit);
  return {
    trackedMinutes: tracked, approvedMinutes: approved, pendingMinutes: pending, disputedMinutes: disputed, noResultMinutes: noResult,
    eligibleMinutes: eligible, payableMinutes: payable, limitMinutes: limit,
    limitReached: limit !== null && tracked >= limit,
    amountDueTiyn: amountFor(terms, payable),
  };
}

export function amountFor(terms: Terms, payableMinutes: number): number {
  if (terms.payKind === 'fixed') return terms.fixedAmountTiyn ?? 0;
  if (terms.payKind === 'hourly') return Math.round(((terms.hourlyRateTiyn ?? 0) * payableMinutes) / 60);
  return 0;
}

/** Most the owner may pay under these terms, for the project estimate. */
export function plannedAmount(terms: Terms): number {
  if (terms.payKind === 'fixed') return terms.fixedAmountTiyn ?? 0;
  if (terms.payKind === 'hourly') return (terms.hourlyRateTiyn ?? 0) * (terms.hourLimit ?? 0);
  return 0;
}
