import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { moduleIssues, moduleFacts } from '../journey/module-stages.js';
import type { AgentFile } from './agent-loop.js';
import { AgentRunner, filesDigestOf, promptDigestOf } from './agent-tasks.js';
import { filesWithMarkers, mergeFile, mergeProjects } from './code-merge.js';
import { branchNameFor, mainLine, mergeIntoMainLine, mergePreview, moduleBranch, MERGE_KIND } from './module-branch.js';
import type { Workspace, WorkspaceProvider } from './workspace.js';

const L = { ours: 'основная линия', theirs: 'модуль orders' };
const f = (path: string, content: string): AgentFile => ({ path, content });

describe('module branches: merging code', () => {
  it('takes each side\'s own changes and merges package.json key by key', () => {
    const base = [f('server.js', 'import a\napp.use(a)\nlisten()\n'), f('package.json', JSON.stringify({ name: 'x', dependencies: { express: '4' } }))];
    const ours = [f('server.js', 'import a\nimport b\napp.use(a)\napp.use(b)\nlisten()\n'), f('package.json', JSON.stringify({ name: 'x', dependencies: { express: '4', pg: '8' } })), f('b.js', 'b')];
    const theirs = [f('server.js', 'import a\napp.use(a)\nlisten()\nexport default app\n'), f('package.json', JSON.stringify({ name: 'x', dependencies: { express: '4', zod: '3' } })), f('c.js', 'c')];
    const merged = mergeProjects(base, ours, theirs, L);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.files.find((file) => file.path === 'server.js')!.content, 'import a\nimport b\napp.use(a)\napp.use(b)\nlisten()\nexport default app\n');
    assert.deepEqual(JSON.parse(merged.files.find((file) => file.path === 'package.json')!.content).dependencies, { express: '4', pg: '8', zod: '3' });
    assert.deepEqual(merged.files.map((file) => file.path), ['b.js', 'c.js', 'package.json', 'server.js']);
    assert.deepEqual(merged.changed, ['c.js', 'package.json', 'server.js']);
  });

  it('marks lines both sides changed differently, never picks one', () => {
    const result = mergeFile('server.js', 'a\nX\nb\n', 'a\nOURS\nb\n', 'a\nTHEIRS\nb\n', L);
    assert.equal(result.conflict, 'both_changed');
    assert.equal(result.content, 'a\n<<<<<<< основная линия\nOURS\n=======\nTHEIRS\n>>>>>>> модуль orders\nb\n');
    assert.deepEqual(filesWithMarkers([f('server.js', result.content!), f('ok.js', 'a <<<<<<< b')]), ['server.js']);
    // The same change on both sides is taken once.
    assert.deepEqual(mergeFile('a.js', 'x', 'y', 'y', L), { content: 'y', conflict: null });
    // The same key set to different values in JSON is a conflict too.
    assert.equal(mergeFile('package.json', '{"v":1}', '{"v":2}', '{"v":3}', L).conflict, 'both_changed');
    // A file one side deleted and the other changed keeps both, marked.
    const gone = mergeFile('old.js', 'x\n', null, 'y\n', L);
    assert.equal(gone.conflict, 'changed_and_deleted');
    assert.match(gone.content!, /^<<<<<<< основная линия\n=======\ny\n>>>>>>> модуль orders\n$/);
    // A file deleted on one side and untouched on the other is deleted.
    assert.deepEqual(mergeFile('old.js', 'x', 'x', null, L), { content: null, conflict: null });
  });

  it('names one repository branch per module and one for the main line', () => {
    assert.equal(branchNameFor({ id: '12345678-aaaa', kind: 'change_app', moduleKey: 'orders' }), 'buildpath/module-orders');
    assert.equal(branchNameFor({ id: '12345678-aaaa', kind: MERGE_KIND, moduleKey: 'orders' }), 'buildpath/main-line');
    assert.equal(branchNameFor({ id: '12345678-aaaa', kind: 'build_app', moduleKey: null }), 'buildpath/agent-12345678');
  });
});

describe('module branches (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT line_task_id FROM agent_tasks LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  const setup = async () => {
    const email = `branches-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, new BillingService(prisma!)).create(owner.id, { workspaceId: workspace.id, name: 'Учёт', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const prompt = { system: 's', task: 't' };
    let clock = Date.now();
    const task = (moduleKey: string, files: AgentFile[], extra: { status?: string; lineTaskId?: string | null; kind?: string } = {}) => prisma!.agentTask.create({ data: {
      projectId, kind: extra.kind ?? 'build_app', status: extra.status ?? 'succeeded', moduleKey, lineTaskId: extra.lineTaskId ?? null, profile: 'node-react-pg@1.3.0', locale: 'ru',
      sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt), limits: { turns: 2, wallMs: 1000, costTiyn: null },
      requestedByUserId: owner.id, files: files as never, filesDigest: filesDigestOf(files), createdAt: new Date(clock = Math.max(clock + 5, Date.now() + 1)),
    } });
    const merge = (moduleKey: string) => prisma!.$transaction((tx) => mergeIntoMainLine(tx, { projectId, moduleKey, moduleName: moduleKey, userId: owner.id }));
    return { owner, projectId, task, merge };
  };

  it('keeps each module on its own line and merges accepted modules into the main line', { skip }, async () => {
    const { projectId, task, merge } = await setup();
    const shared = 'import express\nconst app = express()\napp.listen()\n';
    // Two modules built side by side from scratch, before any main line: each touches the shared server file.
    const users1 = await task('users', [f('package.json', '{"name":"app","dependencies":{"express":"4"}}'), f('server.js', 'import express\nconst app = express()\napp.use(users)\napp.listen()\n'), f('users.js', 'users')]);
    await task('orders', [f('package.json', '{"name":"app","dependencies":{"express":"4","zod":"3"}}'), f('server.js', 'import express\nconst app = express()\napp.use(orders)\napp.listen()\n'), f('orders.js', 'orders')]);
    void shared;
    assert.equal((await moduleBranch(prisma!, projectId, 'users')).head?.id, users1.id);
    assert.equal((await mainLine(prisma!, projectId)).version, 0);

    // The first accepted module becomes the main line as it is.
    assert.equal((await mergePreview(prisma!, { projectId, moduleKey: 'users', moduleName: 'users' })).state, 'ready');
    const v1 = await merge('users');
    assert.equal(v1?.version, 1);
    const line1 = await prisma!.agentTask.findUniqueOrThrow({ where: { id: v1!.taskId } });
    assert.deepEqual([line1.kind, line1.status, line1.moduleKey, line1.baseTaskId], [MERGE_KIND, 'queued', 'users', users1.id]);
    assert.equal((line1.files as unknown as AgentFile[]).length, 3);
    assert.equal(await prisma!.projectEvent.count({ where: { projectId, type: 'module_merged' } }), 1);
    // The merged module's branch is closed: its next work starts again from the main line.
    assert.equal((await moduleBranch(prisma!, projectId, 'users')).head, null);

    // The other module changed the same line of the server: no guessing, the merge is refused and the stage says why.
    const preview = await mergePreview(prisma!, { projectId, moduleKey: 'orders', moduleName: 'orders' });
    assert.equal(preview.state, 'conflict');
    assert.equal(preview.behind, true);
    assert.deepEqual(preview.conflicts.map((item) => item.path), ['server.js']);
    assert.deepEqual(JSON.parse(preview.files.find((file) => file.path === 'package.json')!.content).dependencies, { express: '4', zod: '3' });
    await assert.rejects(merge('orders'), (error: { code?: string }) => error.code === 'MODULE_MERGE_CONFLICT');
    const facts = await moduleFacts(prisma!, { projectId, moduleKey: 'orders', roadmap: null, testplan: null });
    assert.ok(moduleIssues(facts).some((issue) => issue.code === 'MODULE_MERGE_CONFLICT' && issue.severity === 'blocking'));

    // A resolution that left markers is never merged.
    await task('orders', preview.files, { kind: 'change_app', lineTaskId: v1!.taskId });
    assert.equal((await mergePreview(prisma!, { projectId, moduleKey: 'orders', moduleName: 'orders' })).state, 'markers');
    // The agent brought the module up to the main line: it now rests on version 1 and merges as it is.
    const resolved = [f('package.json', '{"name":"app","dependencies":{"express":"4","zod":"3"}}'), f('server.js', 'import express\nconst app = express()\napp.use(users)\napp.use(orders)\napp.listen()\n'), f('users.js', 'users'), f('orders.js', 'orders')];
    await task('orders', resolved, { kind: 'change_app', lineTaskId: v1!.taskId });
    const ready = await mergePreview(prisma!, { projectId, moduleKey: 'orders', moduleName: 'orders' });
    assert.deepEqual([ready.state, ready.behind], ['ready', false]);
    const v2 = await merge('orders');
    assert.equal(v2?.version, 2);

    // Reopened later, a module continues on a new branch from the main line; its change merges three-way, cleanly.
    await task('users', [...resolved.filter((file) => file.path !== 'users.js'), f('users.js', 'users v2')], { kind: 'change_app', lineTaskId: v1!.taskId });
    const again = await mergePreview(prisma!, { projectId, moduleKey: 'users', moduleName: 'users' });
    assert.deepEqual([again.state, again.behind], ['ready', true]);
    assert.equal(again.files.find((file) => file.path === 'users.js')!.content, 'users v2');
    assert.equal(again.files.find((file) => file.path === 'orders.js')!.content, 'orders');

    // A failed task with code does not hide the last successful result of the branch.
    await task('users', [f('users.js', 'broken')], { status: 'failed', kind: 'change_app', lineTaskId: v1!.taskId });
    assert.equal((await mergePreview(prisma!, { projectId, moduleKey: 'users', moduleName: 'users' })).files.find((file) => file.path === 'users.js')!.content, 'users v2');
  });

  it('the platform builds and checks a new main-line version without AI and without a charge', { skip }, async () => {
    const { projectId, task, merge } = await setup();
    await task('users', [f('package.json', JSON.stringify({ name: 'app', scripts: { test: 'node --test', start: 'node server.js' } })), f('server.js', 'x')]);
    const v1 = await merge('users');
    const written = new Map<string, string>();
    const commands: string[] = [];
    const fake: Workspace = {
      write: async (path, content) => { written.set(path, content); },
      read: async (path) => written.get(path) ?? null,
      exec: async (command) => { commands.push(command); return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }; },
      close: async () => undefined,
    };
    const provider: WorkspaceProvider = { name: 'fake', open: async () => fake };
    const runner = new AgentRunner(prisma!);
    runner.setAgent(null, provider);
    // Other projects' queued tasks may run first in a shared database: run until this one is done.
    for (let index = 0; index < 20 && (await prisma!.agentTask.findUniqueOrThrow({ where: { id: v1!.taskId } })).status === 'queued'; index += 1) await runner.processNext();
    const done = await prisma!.agentTask.findUniqueOrThrow({ where: { id: v1!.taskId } });
    assert.ok(['succeeded', 'failed'].includes(done.status), done.status);
    assert.equal(written.get('server.js'), 'x');
    assert.ok(commands.includes('npm test'));
    const result = done.result as { merge?: { version: number }; checks?: Array<{ id: string }> };
    assert.equal(result.merge?.version, 1);
    assert.ok(result.checks?.some((check) => check.id === 'install'));
    assert.equal((done.files as unknown as AgentFile[]).length, 2, 'the files stay as merged');
    assert.equal(await prisma!.generationRun.count({ where: { projectId } }), 0, 'no AI request is counted');
  });
});
