// Results of the platform's own test runs flow into the test plan and the implementation plan (PRODUCT_LIFECYCLE §4.8,
// §4.10): each automatic case found in the run gets its result, and a plan task whose cases all passed becomes «готова»
// by itself — or goes back to «в работе» when a case that had passed fails again. Nobody's word is needed, or accepted, for
// an automatic case.
import type { Prisma } from '../generated/prisma/client.js';
import type { Roadmap } from './roadmap.js';
import type { TestPlan } from './testplan.js';

type Tx = Prisma.TransactionClient;

async function approved<T>(tx: Tx, projectId: string, stageKey: string): Promise<{ content: T; versionNumber: number } | null> {
  const stage = await tx.projectStage.findFirst({ where: { projectId, stageKey }, select: { approvedVersionId: true } });
  if (!stage?.approvedVersionId) return null;
  const version = await tx.stageArtifactVersion.findUnique({ where: { id: stage.approvedVersionId }, select: { content: true, versionNumber: true } });
  return version ? { content: version.content as unknown as T, versionNumber: version.versionNumber } : null;
}

const finished = new Set(['done', 'done_with_note']);

/** What changed, for the task report and the project log. */
export interface RunResultSummary { recorded: number; passed: number; failed: number; tasksDone: string[]; tasksReopened: string[] }

/**
 * source run: the platform's run of the agent's tests, for automatic cases. source browser: the AI agent in the browser, for
 * cases marked «ИИ-агент в браузере», with what it observed as the note.
 */
export async function recordRunResults(tx: Tx, input: { projectId: string; agentTaskId: string; userId: string; cases: Record<string, 'passed' | 'failed'>; source?: 'run' | 'browser'; notes?: Record<string, string> }): Promise<RunResultSummary | null> {
  const source = input.source ?? 'run';
  const method = source === 'run' ? 'auto' : 'ai_browser';
  const testplan = await approved<TestPlan>(tx, input.projectId, 'testplan');
  if (!testplan) return null;
  // Only the cases of the plan this source may check: a test named after a case checked by a person proves nothing about it.
  const automatic = new Map(testplan.content.cases.filter((item) => item.method === method).map((item) => [item.key, item]));
  const summary: RunResultSummary = { recorded: 0, passed: 0, failed: 0, tasksDone: [], tasksReopened: [] };
  for (const [caseKey, status] of Object.entries(input.cases)) {
    if (!automatic.has(caseKey)) continue;
    // A person who checked a browser case themselves has the last word: the agent does not overwrite it.
    if (source === 'browser') {
      const existing = await tx.planCaseResult.findUnique({ where: { projectId_caseKey: { projectId: input.projectId, caseKey } }, select: { source: true, planVersion: true } });
      if (existing?.source === 'person' && existing.planVersion === testplan.versionNumber) continue;
    }
    const data = { status, note: input.notes?.[caseKey]?.slice(0, 500) ?? null, planVersion: testplan.versionNumber, byUserId: null, source, agentTaskId: input.agentTaskId };
    await tx.planCaseResult.upsert({ where: { projectId_caseKey: { projectId: input.projectId, caseKey } }, create: { projectId: input.projectId, caseKey, ...data }, update: data });
    summary.recorded += 1;
    summary[status === 'passed' ? 'passed' : 'failed'] += 1;
  }
  const roadmap = await approved<Roadmap>(tx, input.projectId, 'roadmap');
  if (roadmap && summary.recorded) {
    const results = await tx.planCaseResult.findMany({ where: { projectId: input.projectId }, select: { caseKey: true, status: true, planVersion: true } });
    const passed = (key: string) => results.some((row) => row.caseKey === key && row.status === 'passed' && row.planVersion === testplan.versionNumber);
    const states = await tx.planTaskState.findMany({ where: { projectId: input.projectId } });
    for (const task of roadmap.content.modules.flatMap((module) => module.tasks)) {
      const cases = testplan.content.cases.filter((item) => item.task === task.key);
      if (!cases.length) continue;
      const state = states.find((row) => row.taskKey === task.key);
      const all = cases.every((item) => passed(item.key));
      if (all && state?.status !== 'done') {
        await tx.planTaskState.upsert({ where: { projectId_taskKey: { projectId: input.projectId, taskKey: task.key } }, create: { projectId: input.projectId, taskKey: task.key, status: 'done', updatedByUserId: null }, update: { status: 'done', blockedBy: null, updatedByUserId: null } });
        summary.tasksDone.push(task.key);
      } else if (!all && state?.status === 'done') {
        // Green before, red now: the task is not done any more. «Готово с замечанием» is the owner's word and stays.
        await tx.planTaskState.update({ where: { id: state.id }, data: { status: 'in_progress', updatedByUserId: null } });
        summary.tasksReopened.push(task.key);
      }
    }
  }
  await tx.projectEvent.create({ data: { projectId: input.projectId, actorUserId: input.userId, type: 'test_run_results', stageKey: 'testplan', details: { agentTaskId: input.agentTaskId, source, ...summary } as never } });
  return summary;
}

/** When the agent starts a module, its unfinished tasks are in work (blocked ones stay blocked: someone has to unblock them). */
export async function markModuleStarted(tx: Tx, input: { projectId: string; roadmap: Roadmap; module: string; userId: string }) {
  const module = input.roadmap.modules.find((item) => item.key === input.module);
  if (!module) return;
  const states = await tx.planTaskState.findMany({ where: { projectId: input.projectId, taskKey: { in: module.tasks.map((task) => task.key) } } });
  for (const task of module.tasks) {
    const state = states.find((row) => row.taskKey === task.key);
    if (state && (finished.has(state.status) || state.status === 'blocked' || state.status === 'in_progress')) continue;
    await tx.planTaskState.upsert({ where: { projectId_taskKey: { projectId: input.projectId, taskKey: task.key } }, create: { projectId: input.projectId, taskKey: task.key, status: 'in_progress', updatedByUserId: input.userId }, update: { status: 'in_progress', updatedByUserId: input.userId } });
  }
}
