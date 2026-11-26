// «Входящие» and the project activity log: pure rules, tested without a database.
//
// The inbox is not a store of notifications. It is computed from the project state on every request: a stage waiting
// for acceptance, a returned stage, an undecided change notice, a proposal, unapproved hours, an open dispute, an
// unresolved mention. When the state changes the item disappears by itself, so it can never be stale or «forgotten».
// The activity log is the project's event table (project_events) shown with the viewer's access applied.

export type ActivityKind = 'stage' | 'ai' | 'changes' | 'team' | 'money' | 'site' | 'other';
export const activityKinds: ActivityKind[] = ['stage', 'ai', 'changes', 'team', 'money', 'site', 'other'];

const exact: Record<string, ActivityKind> = {
  stage_generated: 'ai', stage_ai_reviewed: 'ai', app_code_generated: 'ai', voice_transcribed: 'ai', analysis_run_requested: 'ai',
  starter_check_requested: 'ai', interview_applied: 'stage', handoff_built: 'stage', assignments_completed: 'team',
  approval_policy_changed: 'stage', stage_request_created: 'team', stage_request_response: 'team', stage_request_filled: 'team', stage_request_cancelled: 'team', review_override: 'stage', ai_spend_limit_changed: 'money', choice_made: 'site',
  browser_check_requested: 'site', deployment_checked: 'site', quality_profile_changed: 'site', route_created: 'stage', project_cancelled: 'other', plan_finish_moved: 'stage', plan_task_status: 'stage',
};
const prefixes: Array<[string, ActivityKind]> = [
  ['specialist_payment_', 'money'], ['specialist_paid_', 'money'], ['top_up_', 'money'], ['refund_', 'money'], ['time_', 'money'], ['dispute_', 'money'],
  ['agent_task_', 'ai'], ['stage_', 'stage'], ['suggestion_', 'stage'], ['rule_', 'stage'], ['playbook_', 'stage'], ['change_', 'changes'],
  ['team_', 'team'], ['specialist_', 'team'], ['ownership_', 'team'], ['master_', 'team'],
  ['site_', 'site'], ['quick_edit_', 'site'], ['domain_', 'site'], ['hosting_', 'site'], ['lead_', 'site'], ['booking_', 'site'], ['order_', 'site'],
  ['repository_', 'site'], ['github_', 'site'], ['ssh_', 'site'],
];

export function kindOf(type: string): ActivityKind {
  if (exact[type]) return exact[type]!;
  return prefixes.find(([prefix]) => type.startsWith(prefix))?.[1] ?? 'other';
}

/** Money of the whole project (wallet, refunds, the AI limit) — only for the owner and managers. */
const projectMoney = (type: string) => type.startsWith('top_up_') || type.startsWith('refund_') || type === 'ai_spend_limit_changed';

export type ActivityViewer =
  | { kind: 'member'; role: string; stageKeys: string[] }
  | { kind: 'specialist'; stageKeys: string[] };

/**
 * Whether a viewer may see an event. Owners and managers see everything. Other members do not see money; a contributor
 * limited to some stages sees those stages and project-wide events. A specialist sees only the stages they are assigned
 * to, including the payments of their own work, never the project's wallet.
 */
export function canSee(viewer: ActivityViewer, event: { type: string; stageKey: string | null }): boolean {
  if (viewer.kind === 'member') {
    if (viewer.role === 'owner' || viewer.role === 'manager') return true;
    if (kindOf(event.type) === 'money') return false;
    return viewer.stageKeys.length === 0 || event.stageKey === null || viewer.stageKeys.includes(event.stageKey);
  }
  if (projectMoney(event.type)) return false;
  return event.stageKey !== null && viewer.stageKeys.includes(event.stageKey);
}

/** Details shown in the log: short scalar facts only, never free text, contacts, tokens or file contents. */
const detailKeys = ['versionNumber', 'sourceStageKey', 'role', 'rating', 'amount', 'status', 'outcome', 'buildVersion', 'approvals', 'byOwner', 'stageKeys', 'baseline', 'to', 'workingDaysLate'] as const;
export function publicDetails(raw: unknown): Record<string, string | number | boolean | string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const key of detailKeys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.length <= 60) out[key] = value;
    else if (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= 40)) out[key] = value as string[];
  }
  return out;
}

export type InboxKind = 'stage_review' | 'stage_changes' | 'change_notice' | 'change_proposal' | 'time_entries' | 'dispute' | 'mention' | 'request_responses' | 'plan_tasks' | 'plan_slip';
export interface InboxItem {
  id: string;
  kind: InboxKind;
  projectId: string;
  projectName: string;
  projectType: string | null;
  stageKey: string | null;
  /** When the item started waiting. */
  since: string;
  /** A deadline, when the process has one (change notices). */
  dueAt: string | null;
  /** How many things are grouped in the item (hours waiting for approval). */
  count: number;
  /** Who is waiting for the answer, when it is one person. */
  who: string | null;
  /** A short quote: the proposal or the comment. */
  text: string | null;
}

const urgency: Record<InboxKind, number> = { dispute: 0, change_notice: 1, stage_review: 2, stage_changes: 3, plan_slip: 4, change_proposal: 5, plan_tasks: 6, request_responses: 7, time_entries: 8, mention: 9 };

/** Overdue first, then by deadline, then by how urgent the kind is, then the oldest. */
export function orderInbox(items: InboxItem[], now: Date = new Date()): InboxItem[] {
  const overdue = (item: InboxItem) => (item.dueAt && new Date(item.dueAt) < now ? 0 : 1);
  return [...items].sort((a, b) =>
    overdue(a) - overdue(b)
    || (a.dueAt && b.dueAt ? a.dueAt.localeCompare(b.dueAt) : a.dueAt ? -1 : b.dueAt ? 1 : 0)
    || urgency[a.kind] - urgency[b.kind]
    || a.since.localeCompare(b.since));
}

export function quote(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A person as others see them: the name from their account; never the e-mail (the screen says «участник»). */
export function displayName(user: { name: string | null } | null | undefined): string | null {
  return user?.name?.trim() || null;
}
