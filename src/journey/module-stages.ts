// Module stages (PRODUCT_LIFECYCLE §4.9): every module of an application's accepted «План реализации» becomes its own stage
// m_<module>, after the developer package. A module stage has its own page, its own lead (a specialist or the AI agent) and
// its own acceptance; a change of the contracts or the plan reaches each module stage as a change notice.
import type { Prisma } from '../generated/prisma/client.js';
import { tr } from '../i18n/i18n.js';
import { ArtifactValidationError } from './artifacts.js';
import { isModuleStageKey, moduleStageKey, routeInputs, type StageKey } from './catalog.js';
import type { Roadmap } from './roadmap.js';
import { isSatisfied, type StageStatus, type StatusMap } from './stage-state.js';
import type { TestPlan } from './testplan.js';

/** What the module stage keeps: the lead's own words on what was done and what to look at. The rest is live data. */
export interface ModuleWork { summary: string }

export function normalizeModuleWork(raw: unknown): ModuleWork {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const summary = typeof value.summary === 'string' ? value.summary.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim() : '';
  if (summary.length > 2000) throw new ArtifactValidationError('FIELD_TOO_LONG:summary');
  return { summary };
}

/** A module stage whose module is gone from the accepted plan keeps its work but is set aside with this note. */
export const MODULE_REMOVED_NOTE = 'MODULE_REMOVED_FROM_PLAN';
/** Module stages sort after every catalog stage. */
const MODULE_POSITION_BASE = 100;

type Tx = Prisma.TransactionClient;
type StageRowLite = { id: string; stageKey: string; status: string; currentVersionId: string | null; title: string | null; position: number; reviewNote: string | null };

/**
 * Brings the module stages in line with the accepted plan: a new module gets its stage (open when the contracts, the plan,
 * the test plan and the package are accepted, otherwise closed), a renamed one its new name, a removed one is deleted if
 * nobody worked on it and set aside otherwise. Work already done on a module stage is never thrown away.
 */
export async function syncModuleStages(tx: Tx, input: {
  projectId: string; userId: string; roadmap: Roadmap; typeStages: readonly StageKey[]; stages: StageRowLite[]; statuses: StatusMap; definitionVersion: string;
}): Promise<{ created: string[]; removed: string[]; setAside: string[] }> {
  // One sync at a time per project; the module stages are read again under the lock.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`module-stages:${input.projectId}`}))`;
  const existing: StageRowLite[] = (await tx.projectStage.findMany({ where: { projectId: input.projectId }, select: { id: true, stageKey: true, status: true, currentVersionId: true, title: true, position: true, reviewNote: true } }))
    .filter((stage) => isModuleStageKey(stage.stageKey));
  const wanted = input.roadmap.modules.map((module, index) => ({ key: moduleStageKey(module.key), moduleKey: module.key, title: module.name.slice(0, 120), position: MODULE_POSITION_BASE + index }));
  // The route these stages will be in, to know which of them can open now.
  const route: StageKey[] = [...input.typeStages.filter((key) => input.stages.some((stage) => stage.stageKey === key))];
  const at = route.indexOf('handoff') >= 0 ? route.indexOf('handoff') + 1 : route.length;
  route.splice(at, 0, ...wanted.map((item) => item.key));
  const opens = (key: StageKey) => routeInputs(route, key).every((inputKey) => isSatisfied(input.statuses[inputKey]));
  const created: string[] = []; const removed: string[] = []; const setAside: string[] = [];
  for (const item of wanted) {
    const row = existing.find((stage) => stage.stageKey === item.key);
    if (!row) {
      await tx.projectStage.create({ data: { projectId: input.projectId, stageKey: item.key, moduleKey: item.moduleKey, title: item.title, position: item.position, status: opens(item.key) ? 'ready' : 'locked', definitionVersion: input.definitionVersion } });
      created.push(item.moduleKey);
      continue;
    }
    const back = row.reviewNote === MODULE_REMOVED_NOTE;
    if (row.title !== item.title || row.position !== item.position || back) {
      const status: StageStatus | undefined = back ? (row.currentVersionId ? 'in_progress' : opens(item.key) ? 'ready' : 'locked') : undefined;
      await tx.projectStage.update({ where: { id: row.id }, data: { title: item.title, position: item.position, ...(back ? { reviewNote: null, status } : {}) } });
    }
  }
  for (const row of existing.filter((stage) => !wanted.some((item) => item.key === stage.stageKey))) {
    const moduleKey = row.stageKey.slice(2);
    const touched = Boolean(row.currentVersionId) || (await tx.stageAssignment.count({ where: { stageId: row.id } })) > 0 || (await tx.stageComment.count({ where: { stageId: row.id } })) > 0;
    if (!touched) { await tx.projectStage.delete({ where: { id: row.id } }); removed.push(moduleKey); continue; }
    if (row.reviewNote !== MODULE_REMOVED_NOTE) await tx.projectStage.update({ where: { id: row.id }, data: { status: 'blocked', reviewNote: MODULE_REMOVED_NOTE } });
    // Nothing to decide about a plan the module is no longer in.
    await tx.changeNotice.updateMany({ where: { targetStageId: row.id, status: { in: ['open', 'discussing'] } }, data: { status: 'superseded' } });
    setAside.push(moduleKey);
  }
  if (created.length || removed.length || setAside.length) {
    await tx.projectEvent.create({ data: { projectId: input.projectId, actorUserId: input.userId, type: 'module_stages_synced', stageKey: 'roadmap', details: { created, removed, setAside } } });
  }
  return { created, removed, setAside };
}

export interface ModuleFacts {
  moduleKey: string;
  inPlan: boolean;
  tasks: Array<{ key: string; title: string; status: string; cases: number; passed: number; failed: number; fromCase: string | null }>;
  cases: Array<{ key: string; title: string; task: string; method: string; status: 'passed' | 'failed' | null; stale: boolean }>;
  /** The latest agent task of this module: whether it finished and its platform checks passed. */
  agent: { taskId: string; status: string; checksFailed: number } | null;
}

const finished = (status: string) => status === 'done' || status === 'done_with_note';

/** What is known about a module now: its tasks and their states, its cases and their results, and the agent's last task. */
export async function moduleFacts(db: Pick<Tx, 'planTaskState' | 'planCaseResult' | 'agentTask'>, input: { projectId: string; moduleKey: string; roadmap: Roadmap | null; testplan: { plan: TestPlan; versionNumber: number } | null }): Promise<ModuleFacts> {
  const module = input.roadmap?.modules.find((item) => item.key === input.moduleKey) ?? null;
  const [states, results, agentRow] = await Promise.all([
    db.planTaskState.findMany({ where: { projectId: input.projectId } }),
    db.planCaseResult.findMany({ where: { projectId: input.projectId } }),
    db.agentTask.findFirst({ where: { projectId: input.projectId, moduleKey: input.moduleKey }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, result: true } }),
  ]);
  // The owner's remarks on scenarios are tasks of the module of the case's task.
  const extras = states.filter((row) => row.fromCaseKey && row.moduleKey === input.moduleKey);
  const taskList = [...(module?.tasks ?? []).map((task) => ({ key: task.key, title: task.title, fromCase: null as string | null })), ...extras.map((row) => ({ key: row.taskKey, title: row.title ?? row.taskKey, fromCase: row.fromCaseKey }))];
  const taskKeys = new Set(taskList.map((task) => task.key));
  const cases = (input.testplan?.plan.cases ?? []).filter((item) => item.task !== null && taskKeys.has(item.task)).map((item) => {
    const row = results.find((result) => result.caseKey === item.key);
    return { key: item.key, title: item.title, task: item.task as string, method: item.method, status: row ? row.status as 'passed' | 'failed' : null, stale: Boolean(row && row.planVersion !== input.testplan!.versionNumber) };
  });
  const tasks = taskList.map((task) => {
    const own = cases.filter((item) => item.task === task.key);
    return { ...task, status: states.find((row) => row.taskKey === task.key)?.status ?? 'not_started', cases: own.length, passed: own.filter((item) => item.status === 'passed' && !item.stale).length, failed: own.filter((item) => item.status === 'failed').length };
  });
  // «cases» is informative (cases are counted above); the build, tests and start decide whether the code works.
  const checks = ((agentRow?.result as { checks?: Array<{ id?: string; status?: string }> } | null)?.checks ?? []);
  return {
    moduleKey: input.moduleKey, inPlan: Boolean(module), tasks, cases,
    agent: agentRow ? { taskId: agentRow.id, status: agentRow.status, checksFailed: checks.filter((check) => check.id !== 'cases' && (check.status === 'failed' || check.status === 'timed_out')).length } : null,
  };
}

export interface ModuleIssue { code: string; severity: 'blocking' | 'important' | 'minor'; target: string; message: string; fix: string }

/** What stops a module from being accepted: honest readiness comes from cases and the platform's checks, not anyone's word. */
export function moduleIssues(facts: ModuleFacts): ModuleIssue[] {
  const out: ModuleIssue[] = [];
  if (!facts.inPlan) out.push({ code: 'MODULE_NOT_IN_PLAN', severity: 'blocking', target: facts.moduleKey, message: tr('Этого модуля больше нет в принятом плане реализации.'), fix: tr('Верните модуль в план или оставьте этап: принимать его нечего.') });
  const open = facts.tasks.filter((task) => !finished(task.status));
  if (open.length) out.push({ code: 'MODULE_TASKS_OPEN', severity: 'blocking', target: facts.moduleKey, message: tr('Не готовы задачи модуля: {0}.', [open.slice(0, 5).map((task) => task.title).join('; ') + (open.length > 5 ? ' …' : '')]), fix: tr('Задача становится готовой, когда её кейсы проходят. Поручите модуль ИИ-агенту или отметьте кейсы, которые проверяют люди.') });
  const failed = facts.cases.filter((item) => item.status === 'failed');
  if (failed.length) out.push({ code: 'MODULE_CASES_FAILED', severity: 'blocking', target: facts.moduleKey, message: tr('Не проходят кейсы: {0}.', [failed.slice(0, 5).map((item) => item.title).join('; ')]), fix: tr('Исправьте модуль и запустите проверку снова.') });
  if (!facts.agent || facts.agent.status !== 'succeeded') out.push({ code: 'MODULE_NOT_BUILT', severity: 'important', target: facts.moduleKey, message: tr('Платформа ещё не собирала и не проверяла код этого модуля.'), fix: tr('Поручите модуль ИИ-агенту: после работы платформа соберёт код и запустит тесты.') });
  else if (facts.agent.checksFailed) out.push({ code: 'MODULE_CHECKS_FAILED', severity: 'blocking', target: facts.moduleKey, message: tr('Проверки платформы последней сборки модуля не прошли: {0}.', [facts.agent.checksFailed]), fix: tr('Поручите агенту исправить, что показали проверки.') });
  const uncovered = facts.tasks.filter((task) => !task.fromCase && task.cases === 0);
  if (uncovered.length) out.push({ code: 'MODULE_TASK_WITHOUT_CASES', severity: 'minor', target: facts.moduleKey, message: tr('У задач нет кейсов проверки: {0}.', [uncovered.slice(0, 5).map((task) => task.title).join('; ')]), fix: tr('Добавьте кейсы в план проверки — без них готовность задачи не подтвердить.') });
  return out;
}
