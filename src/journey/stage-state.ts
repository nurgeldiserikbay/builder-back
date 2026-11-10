// Pure, deterministic stage transition rules. The service applies their result inside a transaction.
import { routeAncestors, routeInputs, type StageKey } from './catalog.js';

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
 * Reopening an accepted stage changes only that stage. Stages built on it keep using its last accepted version
 * (see effectiveStatuses) until a new version is accepted; then each of them gets a change notice to decide on.
 */
export function reopenStage(statuses: StatusMap, key: StageKey): StatusMap {
  return { ...statuses, [key]: 'in_progress' as StageStatus };
}

/**
 * Statuses as seen by dependent stages: a stage that has an accepted version and is being changed again
 * still provides that accepted version, so work built on it can go on.
 */
export function effectiveStatuses(statuses: StatusMap, hasAcceptedVersion: (key: StageKey) => boolean): StatusMap {
  const next: StatusMap = { ...statuses };
  for (const [key, status] of Object.entries(statuses) as Array<[StageKey, StageStatus]>) {
    if ((status === 'in_progress' || status === 'in_review' || status === 'changes_requested' || status === 'stale') && hasAcceptedVersion(key)) next[key] = 'approved';
  }
  return next;
}

/** Stages that use the given stage directly as an input. */
export function directDependents(route: StageKey[], key: StageKey): StageKey[] {
  return route.filter((candidate) => routeInputs(route, candidate).includes(key));
}

export function canEdit(status: StageStatus | undefined): boolean {
  return status === 'ready' || status === 'awaiting_lead' || status === 'in_progress' || status === 'stale' || status === 'changes_requested';
}

export function nextStage(route: StageKey[], statuses: StatusMap): StageKey | null {
  return route.find((key) => !isSatisfied(statuses[key]) && statuses[key] !== 'locked')
    ?? route.find((key) => !isSatisfied(statuses[key])) ?? null;
}
