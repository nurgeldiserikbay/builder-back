import { tr } from '../i18n/i18n.js';

/**
 * Project team and approval policy rules. Pure functions: the services load rows and apply these, so the same decision is
 * made in the web app, the API and tests.
 */

export type ProjectRole = 'owner' | 'manager' | 'contributor' | 'reviewer' | 'viewer';
export const INVITABLE_ROLES = ['manager', 'contributor', 'reviewer', 'viewer'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];
export const TEAM_LIMIT = 20;
export const INVITE_DAYS = 7;

export const roleInfo: Record<ProjectRole, { title: string; explanation: string }> = {
  owner: { title: 'Владелец', explanation: 'Управляет проектом, командой и правилами согласования.' },
  manager: { title: 'Администратор', explanation: 'Ведёт этапы, приглашает исполнителей, проверяющих и наблюдателей, настраивает согласование. Не может передать проект.' },
  contributor: { title: 'Исполнитель', explanation: 'Работает над этапами и отправляет результат на проверку. Не принимает этапы и не управляет командой.' },
  reviewer: { title: 'Проверяющий', explanation: 'Смотрит материалы, одобряет версию или просит доработать там, где назначен проверяющим. Ничего не меняет.' },
  viewer: { title: 'Наблюдатель', explanation: 'Только смотрит проект: без изменений и согласования.' },
};

/** Who may invite, change or remove a member with this role. The owner manages everyone; a manager — everyone below a manager. */
export function canManage(actor: string, target: string): boolean {
  if (target === 'owner') return false;
  if (actor === 'owner') return true;
  return actor === 'manager' && target !== 'manager';
}

/** Roles that can be named as reviewers in an approval policy: everyone except observers. */
export const APPROVER_ROLES = new Set(['owner', 'manager', 'contributor', 'reviewer']);

export type ApprovalMode = 'one' | 'all' | 'quorum';
/** order — parallel: anyone of them in any order; sequential: one after another in the listed order, each sees the previous approvals. */
export type ApprovalOrder = 'parallel' | 'sequential';
export type ApprovalPolicy = { mode: ApprovalMode; reviewers: string[]; quorum: number | null; authorMayApprove: boolean; order: ApprovalOrder };

/** Checks what the owner sent against the current team; returns the stored form or an error code. */
export function checkPolicy(input: { mode: unknown; reviewers: unknown; quorum: unknown; authorMayApprove: unknown; order?: unknown }, members: Map<string, string>): ApprovalPolicy | string {
  if (input.mode !== 'one' && input.mode !== 'all' && input.mode !== 'quorum') return 'POLICY_MODE_INVALID';
  if (!Array.isArray(input.reviewers) || !input.reviewers.every((id) => typeof id === 'string')) return 'POLICY_REVIEWERS_INVALID';
  const reviewers = [...new Set(input.reviewers as string[])];
  if (reviewers.length < 1 || reviewers.length > 10) return 'POLICY_REVIEWERS_COUNT';
  if (reviewers.some((id) => !APPROVER_ROLES.has(members.get(id) ?? ''))) return 'POLICY_REVIEWER_NOT_MEMBER';
  let quorum: number | null = null;
  if (input.mode === 'quorum') {
    if (!Number.isInteger(input.quorum) || (input.quorum as number) < 1 || (input.quorum as number) > reviewers.length) return 'POLICY_QUORUM_INVALID';
    quorum = input.quorum as number;
  }
  if (typeof input.authorMayApprove !== 'boolean') return 'POLICY_AUTHOR_INVALID';
  const order = input.order === undefined || input.order === null ? 'parallel' : input.order;
  if (order !== 'parallel' && order !== 'sequential') return 'POLICY_ORDER_INVALID';
  return { mode: input.mode, reviewers, quorum, authorMayApprove: input.authorMayApprove, order };
}

/** Reads a stored policy; anything malformed counts as «no policy» (the owner or a manager accepts alone). */
export function readPolicy(value: unknown): ApprovalPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode !== 'one' && raw.mode !== 'all' && raw.mode !== 'quorum') return null;
  if (!Array.isArray(raw.reviewers)) return null;
  return {
    mode: raw.mode, reviewers: raw.reviewers.filter((id): id is string => typeof id === 'string'),
    quorum: typeof raw.quorum === 'number' ? raw.quorum : null, authorMayApprove: raw.authorMayApprove === true,
    order: raw.order === 'sequential' ? 'sequential' : 'parallel',
  };
}

export type ApprovalState = {
  /** Reviewers who are still active members with a role that may approve. */
  eligible: string[];
  /** Approvals that count: given by an eligible reviewer for this version in this round. */
  approvedBy: string[];
  required: number;
  met: boolean;
  /** The policy can no longer be met with the current team — the owner has to change it. */
  broken: boolean;
  waitingFor: string[];
  /** Sequential review: whose turn it is now; null when parallel or nobody is left. */
  next: string | null;
};

export function approvalState(policy: ApprovalPolicy, members: Map<string, string>, approvals: string[], authorId: string | null): ApprovalState {
  const eligible = policy.reviewers.filter((id) => APPROVER_ROLES.has(members.get(id) ?? ''));
  // The author's approval does not count unless the policy allows it; they also cannot be waited for.
  const canApprove = eligible.filter((id) => policy.authorMayApprove || id !== authorId);
  const approvedBy = [...new Set(approvals)].filter((id) => canApprove.includes(id));
  const required = policy.mode === 'one' ? 1 : policy.mode === 'all' ? canApprove.length : (policy.quorum ?? 1);
  const broken = canApprove.length === 0 || required > canApprove.length || (policy.mode === 'all' && eligible.length < policy.reviewers.length);
  const waitingFor = canApprove.filter((id) => !approvedBy.includes(id));
  const met = !broken && approvedBy.length >= required;
  return { eligible, approvedBy, required, met, broken, waitingFor, next: policy.order === 'sequential' && !met ? waitingFor[0] ?? null : null };
}

/** Why this user cannot approve this version right now, or null when they can. approvals — who already approved it. */
export function approveBlocker(policy: ApprovalPolicy, members: Map<string, string>, userId: string, authorId: string | null, approvals: string[]): string | null {
  if (!policy.reviewers.includes(userId)) return 'NOT_A_REVIEWER';
  if (!APPROVER_ROLES.has(members.get(userId) ?? '')) return 'NOT_A_REVIEWER';
  if (!policy.authorMayApprove && userId === authorId) return 'AUTHOR_CANNOT_APPROVE';
  if (approvals.includes(userId)) return 'ALREADY_APPROVED';
  if (policy.order === 'sequential') {
    const next = approvalState(policy, members, approvals, authorId).next;
    if (next && next !== userId) return 'NOT_YOUR_TURN';
  }
  return null;
}

export function policyText(policy: ApprovalPolicy, names: (id: string) => string): string {
  const who = policy.reviewers.map(names).join(', ');
  const rule = policy.mode === 'one' ? tr('Нужно одобрение любого из проверяющих: {0}.', [who])
    : policy.mode === 'all' ? tr('Нужно одобрение всех проверяющих: {0}.', [who]) : tr('Нужно одобрение {0} из {1} проверяющих: {2}.', [policy.quorum, policy.reviewers.length, who]);
  const order = policy.order === 'sequential' ? ` ${tr('По очереди, в этом порядке.')}` : '';
  return policy.authorMayApprove ? `${rule}${order}` : `${rule}${order} ${tr('Автор версии свою версию не одобряет.')}`;
}
