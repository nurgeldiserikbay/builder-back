// Pure, deterministic stage transition rules. The service applies their result inside a transaction.
import { routeAncestors, routeDependents, routeInputs, type StageKey } from './catalog.js';

export type StageStatus = 'locked' | 'ready' | 'awaiting_lead' | 'in_progress' | 'in_review' | 'changes_requested'
  | 'approved' | 'stale' | 'imported' | 'skipped' | 'blocked';

export type StatusMap = Partial<Record<StageKey, StageStatus>>;

export function isSatisfied(status: StageStatus | undefined): boolean {
  return status === 'approved' || status === 'imported' || status === 'skipped';
}

export function inputsSatisfied(route: StageKey[], statuses: StatusMap, key: StageKey): boolean {
  return routeInputs(route, key).every((input) => isSatisfied(statuses[input]));
}

/** Initial statuses. Starting from a later stage opens its earlier stages so the owner can bring ready materials. */
export function initialStatuses(route: StageKey[], startStageKey: StageKey | null): StatusMap {
  const statuses: StatusMap = {};
  const open = new Set<StageKey>(startStageKey ? [startStageKey, ...routeAncestors(route, startStageKey)] : []);
  for (const key of route) {
    statuses[key] = routeInputs(route, key).length === 0 || open.has(key) ? 'ready' : 'locked';
  }
  return statuses;
}

/** After a stage becomes satisfied, unlock dependents whose inputs are now all satisfied. */
export function unlockDependents(route: StageKey[], statuses: StatusMap): StatusMap {
  const next = { ...statuses };
  for (const key of route) {
    if (next[key] === 'locked' && inputsSatisfied(route, next, key)) next[key] = 'ready';
  }
  return next;
}

/**
 * Reopening an accepted stage invalidates everything built on it: accepted dependents become "stale",
 * untouched dependents close again. Work in progress stays, but cannot be accepted until inputs are accepted.
 */
export function reopenStage(route: StageKey[], statuses: StatusMap, key: StageKey, hasDraft: (key: StageKey) => boolean): StatusMap {
  const next = { ...statuses, [key]: 'in_progress' as StageStatus };
  for (const dependent of routeDependents(route, key)) {
    const status = next[dependent];
    if (status === 'approved' || status === 'imported') next[dependent] = 'stale';
    else if (status === 'ready' && !hasDraft(dependent)) next[dependent] = 'locked';
  }
  return next;
}

export function canEdit(status: StageStatus | undefined): boolean {
  return status === 'ready' || status === 'in_progress' || status === 'stale' || status === 'changes_requested';
}

export function nextStage(route: StageKey[], statuses: StatusMap): StageKey | null {
  return route.find((key) => !isSatisfied(statuses[key]) && statuses[key] !== 'locked')
    ?? route.find((key) => !isSatisfied(statuses[key])) ?? null;
}
