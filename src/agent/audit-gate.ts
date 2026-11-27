// Release gate on known vulnerabilities (TECHNICAL_SPECIFICATION §8, dependency audit).
//
// The agent's own task is not stopped by the audit: it only informs. What may not happen silently is accepting a module or
// launching the application while its last build has a critical or high advisory: that becomes a blocking remark of the
// module stage and of «Запуск». As with every blocking remark, the owner may go on only by writing why (the stage history
// keeps it); the honest way is to ask the agent to upgrade the packages. An audit that could not run is said so: it is an
// important remark, never «clean».

import type { AgentCheck, AuditSummary } from './agent-loop.js';
import { MERGE_KIND } from './module-branch.js';

export type AuditFact =
  | { state: 'clean'; taskId: string }
  | { state: 'unchecked'; taskId: string }
  | { state: 'vulnerable'; taskId: string; critical: number; high: number; packages: string[] };

/** The audit of one task's checks; null when the task has none (an older task, or it stopped before the install). */
export function auditFact(taskId: string, result: unknown): AuditFact | null {
  const checks = ((result as { checks?: AgentCheck[] } | null)?.checks ?? []);
  const audit = checks.find((check) => check.id === 'audit');
  if (!audit) return null;
  const summary = audit.vulnerabilities as AuditSummary | undefined;
  if (audit.status === 'skipped' || !summary) return { state: 'unchecked', taskId };
  if (summary.critical + summary.high === 0) return { state: 'clean', taskId };
  return {
    state: 'vulnerable', taskId, critical: summary.critical, high: summary.high,
    packages: summary.packages.filter((item) => item.severity === 'critical' || item.severity === 'high').map((item) => item.name).slice(0, 5),
  };
}

/**
 * The code that would be launched: the latest main-line version when the project builds by modules, otherwise the latest
 * finished whole-application task (a build or a change). Null when the agent has not built anything that finished.
 */
export async function launchAudit(db: { agentTask: { findFirst: (args: never) => Promise<{ id: string; result: unknown } | null>; count: (args: never) => Promise<number> } }, projectId: string): Promise<AuditFact | null> {
  const byModules = await db.agentTask.count({ where: { projectId, kind: MERGE_KIND } } as never) > 0;
  const where = byModules ? { projectId, kind: MERGE_KIND, status: 'succeeded' } : { projectId, moduleKey: null, status: 'succeeded' };
  const task = await db.agentTask.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { id: true, result: true } } as never);
  return task ? auditFact(task.id, task.result) : null;
}
