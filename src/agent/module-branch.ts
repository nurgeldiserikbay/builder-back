// Module branches (PRODUCT_LIFECYCLE §4.9). Each module of the implementation plan has its own line of code: its agent
// tasks start from the project's main line and continue from the module's own last result, never from another module's
// unfinished work. When the module's stage is accepted, its code is merged into the main line (code-merge.ts) as a
// «line_merge» task: the merged files, checked by the platform like any build, pushed and deployed like any task.
import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { tr } from '../i18n/i18n.js';
import type { AgentFile } from './agent-loop.js';
import { filesWithMarkers, mergeProjects, type MergeConflict } from './code-merge.js';

type Db = Pick<Prisma.TransactionClient, 'agentTask'>;

export const MERGE_KIND = 'line_merge';
const ACTIVE = ['queued', 'running'];
const digestOf = (files: AgentFile[]) => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const filesOf = (row: { files: unknown } | null | undefined) => ((row?.files ?? []) as unknown as AgentFile[]);

/** The branch a task's code goes to in the owner's repository: one per module, one for the main line. */
export function branchNameFor(task: { id: string; kind: string; moduleKey: string | null }): string {
  if (task.kind === MERGE_KIND) return 'buildpath/main-line';
  if (task.moduleKey && /^[A-Za-z0-9._-]{1,60}$/.test(task.moduleKey)) return `buildpath/module-${task.moduleKey}`;
  return `buildpath/agent-${task.id.slice(0, 8)}`;
}

export const mergeLabels = (moduleName: string) => ({ ours: tr('основная линия'), theirs: tr('модуль {0}', [moduleName]) });

/** The main line now: its last merge (null before the first module is accepted) and its version number. */
export async function mainLine(db: Db, projectId: string) {
  const [head, version] = await Promise.all([
    db.agentTask.findFirst({ where: { projectId, kind: MERGE_KIND }, orderBy: { createdAt: 'desc' }, select: { id: true, files: true, moduleKey: true, status: true, createdAt: true, result: true } }),
    db.agentTask.count({ where: { projectId, kind: MERGE_KIND } }),
  ]);
  return { head, version };
}

/**
 * A module's branch: its tasks since the module was last merged. The head is the last result to build on — the last
 * successful one, or else the last one that left code.
 */
export async function moduleBranch(db: Db, projectId: string, moduleKey: string) {
  const lastMerge = await db.agentTask.findFirst({ where: { projectId, kind: MERGE_KIND, moduleKey }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
  const tasks = await db.agentTask.findMany({
    where: { projectId, moduleKey, kind: { not: MERGE_KIND }, ...(lastMerge ? { createdAt: { gt: lastMerge.createdAt } } : {}) },
    orderBy: { createdAt: 'desc' }, take: 50,
    select: { id: true, status: true, files: true, filesDigest: true, lineTaskId: true, createdAt: true, profile: true, locale: true, sourceVersionId: true, inputVersionIds: true, limits: true },
  });
  const usable = (task: typeof tasks[number]) => !ACTIVE.includes(task.status) && filesOf(task).length > 0 && task.filesDigest === digestOf(filesOf(task));
  const head = tasks.find((task) => task.status === 'succeeded' && usable(task)) ?? tasks.find(usable) ?? null;
  return { tasks: tasks.length, active: tasks.some((task) => ACTIVE.includes(task.status)), head, lastMergeId: lastMerge?.id ?? null };
}

export type MergeState = 'nothing' | 'ready' | 'conflict' | 'markers';
export interface MergePreview {
  state: MergeState;
  /** The main line moved on since the module's code started from it (another module was merged meanwhile). */
  behind: boolean;
  conflicts: MergeConflict[];
  /** Files still holding conflict markers (an unfinished resolution). */
  markers: string[];
  changed: number;
  files: AgentFile[];
  headId: string | null;
  mainHeadId: string | null;
  mainVersion: number;
}

/** What merging the module's head into the main line would give now. Nothing is written. */
export async function mergePreview(db: Db, input: { projectId: string; moduleKey: string; moduleName: string }): Promise<MergePreview> {
  const [branch, main] = await Promise.all([moduleBranch(db, input.projectId, input.moduleKey), mainLine(db, input.projectId)]);
  const empty = { conflicts: [], markers: [], changed: 0, files: [], mainHeadId: main.head?.id ?? null, mainVersion: main.version };
  if (!branch.head) return { state: 'nothing', behind: false, headId: null, ...empty };
  const theirs = filesOf(branch.head);
  const markers = filesWithMarkers(theirs);
  const behind = (main.head?.id ?? null) !== (branch.head.lineTaskId ?? null);
  if (markers.length) return { ...empty, state: 'markers', behind, markers, headId: branch.head.id };
  if (!behind) return { ...empty, state: 'ready', behind, files: theirs, changed: theirs.length, headId: branch.head.id };
  const base = branch.head.lineTaskId ? filesOf(await db.agentTask.findUnique({ where: { id: branch.head.lineTaskId }, select: { files: true } })) : [];
  const merged = mergeProjects(base, filesOf(main.head), theirs, mergeLabels(input.moduleName));
  return { ...empty, state: merged.conflicts.length ? 'conflict' : 'ready', behind, conflicts: merged.conflicts, changed: merged.changed.length, files: merged.files, headId: branch.head.id };
}

/**
 * The accepted module enters the main line: a new main-line version with the merged files. The platform then builds and
 * checks it (queued); the version exists whatever the checks say, and they are shown with it. Called inside the accepting
 * transaction, under the project's agent lock, so two modules accepted at once are merged one after the other.
 */
export async function mergeIntoMainLine(tx: Prisma.TransactionClient, input: { projectId: string; moduleKey: string; moduleName: string; userId: string }): Promise<{ taskId: string; version: number } | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${input.projectId}`}))`;
  const preview = await mergePreview(tx, input);
  if (preview.state === 'nothing') return null;
  if (preview.state !== 'ready') throw Object.assign(new Error('MODULE_MERGE_CONFLICT'), { code: 'MODULE_MERGE_CONFLICT' });
  const head = (await moduleBranch(tx, input.projectId, input.moduleKey)).head!;
  const prompt = { system: '', task: '' };
  const version = preview.mainVersion + 1;
  const task = await tx.agentTask.create({ data: {
    projectId: input.projectId, kind: MERGE_KIND, status: 'queued', moduleKey: input.moduleKey, lineTaskId: preview.mainHeadId, baseTaskId: head.id,
    instruction: null, profile: head.profile, locale: head.locale, sourceVersionId: head.sourceVersionId, inputVersionIds: head.inputVersionIds,
    prompt, promptDigest: createHash('sha256').update(JSON.stringify([prompt.system, prompt.task])).digest('hex'), limits: head.limits as never,
    files: preview.files as never, filesDigest: digestOf(preview.files), requestedByUserId: input.userId,
    result: { merge: { version, module: input.moduleKey, from: head.id, behind: preview.behind, changed: preview.changed }, checks: [] } as never,
  } });
  await tx.projectEvent.create({ data: { projectId: input.projectId, actorUserId: input.userId, type: 'module_merged', stageKey: `m_${input.moduleKey}`, details: { taskId: task.id, version, from: head.id, behind: preview.behind, changed: preview.changed } } });
  return { taskId: task.id, version };
}

/** The words for the agent when a module is brought up to the main line and both changed the same lines. */
export function syncInstruction(input: { moduleName: string; conflicts: MergeConflict[] }): string {
  return [
    tr('Согласуйте модуль «{0}» с основной линией кода проекта: пока модуль делали, в основную линию влили другие модули.', [input.moduleName]),
    tr('В файлах {0} есть пометки конфликтов: между строками «<<<<<<< основная линия» и «=======» — код основной линии, между «=======» и «>>>>>>> модуль …» — код этого модуля.', [input.conflicts.slice(0, 20).map((item) => item.path).join(', ')]),
    tr('Сохраните смысл обеих сторон: ничего из основной линии не теряйте, изменения модуля оставьте. Уберите все пометки, проверьте, что сборка и тесты проходят. Другие модули не переделывайте.'),
  ].join('\n');
}
