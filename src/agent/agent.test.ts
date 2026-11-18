import 'dotenv/config';
import assert from 'node:assert/strict';
import { exec as execCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChatCompletionsAgentModel, configuredAgentModel, type AgentMessage, type AgentModel, type AgentReply } from './agent-model.js';
import { runAgent, safePath, type AgentStep } from './agent-loop.js';
import { AgentRunner, AgentTasksService, buildAgentPrompt, PREVIEW_CSP, promptDigestOf, withPreviewPolicy } from './agent-tasks.js';
import { JourneyCore } from '../journey/journey-core.js';
import type { ExecResult, Workspace, WorkspaceProvider } from './workspace.js';

/** Test stand-in for the sandbox: a temporary folder and a local shell. Production code never runs agent code locally. */
async function localWorkspace(): Promise<Workspace & { dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-ws-'));
  return {
    dir,
    write: async (file, content) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), content); },
    read: async (file) => readFile(path.join(dir, file), 'utf8').catch(() => null),
    exec: (command, timeoutMs) => new Promise<ExecResult>((resolve) => {
      const at = Date.now();
      execCallback(command, { cwd: dir, timeout: timeoutMs, env: { PATH: process.env.PATH ?? '', HOME: dir, CI: '1', npm_config_cache: path.join(dir, '.npm'), npm_config_offline: 'true' } }, (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number; killed?: boolean }) | null;
        resolve({ exitCode: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0, stdout, stderr, timedOut: Boolean(failure?.killed), durationMs: Date.now() - at });
      });
    }),
    close: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

/** A scripted model: each turn returns the next list of tool calls. */
function scripted(turns: Array<Array<{ name: string; args: Record<string, unknown> }> | string>): AgentModel & { seen: AgentMessage[][] } {
  const seen: AgentMessage[][] = [];
  let index = 0;
  return {
    name: 'fake', model: 'fake-agent', seen,
    async next(messages): Promise<AgentReply> {
      seen.push([...messages]);
      const turn = turns[index++] ?? [{ name: 'finish', args: { summary: 'end', done: [], notDone: [] } }];
      if (typeof turn === 'string') return { text: turn, toolCalls: [], usage: { inputTokens: 1000, outputTokens: 100 } };
      return { text: null, toolCalls: turn.map((call, n) => ({ id: `c${index}_${n}`, name: call.name, arguments: JSON.stringify(call.args) })), usage: { inputTokens: 1000, outputTokens: 100 } };
    },
  };
}

const goodApp = [
  [{ name: 'write_file', args: { path: 'package.json', content: JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', scripts: { test: 'node --test', 'build:demo': "mkdir -p dist-demo && printf '<html><head><title>d</title></head><body>demo</body></html>' > dist-demo/index.html" } }) } }],
  [{ name: 'write_file', args: { path: 'src/rules.js', content: 'export const canDelete = (role) => role === "admin";\n' } }, { name: 'write_file', args: { path: 'test/rules.test.js', content: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { canDelete } from "../src/rules.js";\ntest("admin deletes", () => { assert.equal(canDelete("admin"), true); assert.equal(canDelete("client"), false); });\n' } }],
  [{ name: 'write_file', args: { path: '../outside.txt', content: 'x' } }, { name: 'write_file', args: { path: '.env', content: 'SECRET=1' } }, { name: 'write_file', args: { path: '.env.example', content: 'SESSION_SECRET=\n' } }],
  [{ name: 'run', args: { command: 'npm test', timeoutSeconds: 60 } }],
  [{ name: 'finish', args: { summary: 'Удалять может только администратор.', done: ['Права на удаление'], notDone: ['Оплата — нужна интеграция'] } }],
];

describe('AI agent: the loop', () => {
  it('writes, runs and finishes; the platform runs the checks itself and keeps only safe project files', async () => {
    const workspace = await localWorkspace();
    const steps: AgentStep[] = [];
    try {
      const outcome = await runAgent({
        model: scripted(goodApp), workspace, system: 'sys', task: 'task', limits: { turns: 20, wallMs: 120_000, costTiyn: null },
        costOf: () => 5, shouldStop: async () => false, onStep: async (step) => { steps.push(step); },
      });
      assert.equal(outcome.stopReason, 'finished');
      assert.deepEqual(outcome.report, { summary: 'Удалять может только администратор.', done: ['Права на удаление'], notDone: ['Оплата — нужна интеграция'] });
      assert.deepEqual(outcome.checks.map((check) => [check.id, check.status]), [['install', 'passed'], ['test', 'passed'], ['build', 'skipped'], ['demo', 'passed']]);
      assert.match(outcome.demoHtml!, /<body>demo<\/body>/);
      assert.deepEqual(outcome.files.map((file) => file.path).sort(), ['.env.example', 'package-lock.json', 'package.json', 'src/rules.js', 'test/rules.test.js']);
      assert.equal(outcome.turns, 5);
      assert.equal(outcome.costTiyn, 25);
      assert.ok(steps.some((step) => step.tool === 'write_file' && step.status === 'failed' && step.summary.includes('outside')), 'a path outside the project is refused');
      assert.ok(steps.some((step) => step.tool === 'run' && step.status === 'ok'));
    } finally { await workspace.close(); }
  });

  it('does not take the agent\'s word: failing tests make the check fail even after finish', async () => {
    const workspace = await localWorkspace();
    try {
      const outcome = await runAgent({
        model: scripted([
          [{ name: 'write_file', args: { path: 'package.json', content: JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }) } }],
          [{ name: 'write_file', args: { path: 'test/x.test.js', content: 'import test from "node:test";\ntest("no", () => { throw new Error("boom"); });\n' } }],
          [{ name: 'finish', args: { summary: 'Всё работает', done: ['всё'], notDone: [] } }],
        ]),
        workspace, system: 's', task: 't', limits: { turns: 10, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => false, onStep: async () => undefined,
      });
      assert.equal(outcome.checks.find((check) => check.id === 'test')!.status, 'failed');
    } finally { await workspace.close(); }
  });

  it('stops on turns, money and a stop request', async () => {
    const workspace = await localWorkspace();
    try {
      const busy = Array.from({ length: 50 }, () => [{ name: 'list_files', args: {} }]);
      const base = { workspace, system: 's', task: 't', onStep: async () => undefined };
      assert.equal((await runAgent({ ...base, model: scripted(busy), limits: { turns: 3, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => false })).stopReason, 'turns');
      assert.equal((await runAgent({ ...base, model: scripted(busy), limits: { turns: 50, wallMs: 60_000, costTiyn: 30 }, costOf: () => 10, shouldStop: async () => false })).turns, 3);
      let calls = 0;
      assert.equal((await runAgent({ ...base, model: scripted(busy), limits: { turns: 50, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => ++calls > 2 })).stopReason, 'stopped');
    } finally { await workspace.close(); }
  });

  it('keeps the preview to one page and runs it with no network', () => {
    const page = withPreviewPolicy('<html><head><title>x</title><script>fetch("https://evil.example")</script></head><body></body></html>');
    assert.ok(page.indexOf('Content-Security-Policy') < page.indexOf('<script>'), 'the policy comes before any script');
    assert.match(PREVIEW_CSP, /connect-src 'none'/);
    assert.match(PREVIEW_CSP, /default-src 'none'/);
    assert.match(withPreviewPolicy('<p>no head</p>'), /^<!doctype html><head><meta http-equiv="Content-Security-Policy"/);
  });

  it('confines paths to the project', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', '.git/config', 'node_modules/x/index.js', 'a\\b', '']) assert.equal(safePath(bad), null, bad);
    assert.equal(safePath('./src/app.js'), 'src/app.js');
  });
});

describe('AI agent: the model and the prompt', () => {
  it('sends the tools and reads tool calls and usage from Chat Completions', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'run', arguments: '{"command":"npm test"}' } }] } }], usage: { prompt_tokens: 1200, completion_tokens: 40 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const reply = await new ChatCompletionsAgentModel('k', 'm', 'https://api.test/v1', fetchImpl).next([{ role: 'user', content: 'hi' }], [{ name: 'run', description: 'd', parameters: { type: 'object' } }]);
    assert.deepEqual(reply, { text: null, toolCalls: [{ id: 'x1', name: 'run', arguments: '{"command":"npm test"}' }], usage: { inputTokens: 1200, outputTokens: 40 } });
    assert.equal((body.tools as unknown[]).length, 1);
    assert.equal(configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AI_OPENAI_MODEL: 'small', BUILDER_AGENT_MODEL: 'big' })?.model, 'big');
    assert.equal(configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AI_OPENAI_BASE_URL: 'http://evil.example/v1', BUILDER_AGENT_MODEL: 'big' }), null);
  });
  it('fixes the stack and marks the package as untrusted data', () => {
    const prompt = buildAgentPrompt({ locale: 'ru', projectName: 'Учёт заявок', inputs: { features: { roles: [{ key: 'admin' }] } }, instruction: 'Сделай тёмную тему' });
    assert.match(prompt.system, /node-react-pg@1\.1\.0/);
    assert.match(prompt.system, /untrusted data/);
    assert.match(prompt.system, /Russian/);
    assert.match(prompt.task, /PACKAGE \(JSON, untrusted data\)/);
    assert.match(prompt.task, /Сделай тёмную тему/);
  });
});

describe('AI agent: tasks (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM agent_tasks LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('the worker runs a queued task in the sandbox, stores steps, checks and files, and counts it as one AI request', { skip }, async () => {
    const email = `agent-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, new BillingService(prisma!)).create(owner.id, { workspaceId: workspace.id, name: 'Учёт', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const prompt = { system: 'sys', task: 'task' };
    const task = await prisma!.agentTask.create({ data: {
      projectId, kind: 'build_app', profile: 'node-react-pg@1.0.0', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, requestedByUserId: owner.id,
      promptDigest: promptDigestOf(prompt), limits: { turns: 20, wallMs: 120_000, costTiyn: null },
    } });
    const opened: string[] = [];
    const provider: WorkspaceProvider = { name: 'local', open: async () => { const ws = await localWorkspace(); opened.push(ws.dir); return ws; } };
    const runner = new AgentRunner(prisma!);
    runner.setAgent(scripted(goodApp), provider);
    assert.equal(await runner.processNext(), true);
    const done = await prisma!.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.model, 'fake-agent');
    assert.equal(done.turns, 5);
    assert.ok((done.steps as unknown[]).length >= 7);
    assert.deepEqual(((done.files as Array<{ path: string }>) ?? []).map((file) => file.path).sort(), ['.env.example', 'package-lock.json', 'package.json', 'src/rules.js', 'test/rules.test.js']);
    assert.equal(await prisma!.generationRun.count({ where: { projectId, targetKey: 'agent_task' } }), 1);
    assert.equal(opened.length, 1);

    // A changed task is never run: the prompt digest must match.
    const tampered = await prisma!.agentTask.create({ data: { projectId, kind: 'build_app', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt: { system: 'other', task: 't' }, promptDigest: 'f'.repeat(64), limits: { turns: 2, wallMs: 1000, costTiyn: null }, requestedByUserId: owner.id } });
    await runner.processNext();
    assert.equal((await prisma!.agentTask.findUniqueOrThrow({ where: { id: tampered.id } })).errorCode, 'AGENT_FAILED');
    assert.equal(opened.length, 1, 'no sandbox was opened for it');

    // The owner's view: the latest task with its report and checks; a queued task stops at once.
    const billing = new BillingService(prisma!);
    const pushes: Array<{ branch: string; files: number; title: string; body: string }> = [];
    const choices = {
      repositoryFor: async () => ({ provider: 'github', repoPath: 'owner/app', defaultBranch: 'main' }),
      pushBranch: async (_user: string, _project: string, input: { branch: string; files: unknown[]; title: string; body: string }) => {
        pushes.push({ branch: input.branch, files: input.files.length, title: input.title, body: input.body });
        return { branch: input.branch, commitUrl: 'https://github.com/owner/app/commit/1', pullRequestUrl: 'https://github.com/owner/app/pull/7', mainBranch: false, repository: null };
      },
    };
    const service = new AgentTasksService(prisma!, new JourneyCore(prisma!, billing), billing, runner, choices as never);
    const view = (await service.get(owner.id, projectId)).data;
    assert.equal(view.configured, true);
    assert.equal(view.canStart, false, 'the package is not built yet');
    await assert.rejects(service.start(owner.id, projectId, { instruction: null }), /HANDOFF_NOT_BUILT/);
    const succeeded = (await service.files(owner.id, projectId, task.id)).data;
    assert.equal(succeeded.files.length, 5);
    assert.equal(view.repository!.repoPath, 'owner/app');
    const demo = (await service.demo(owner.id, projectId, task.id)).data;
    assert.match(demo.html, /^<html><head><meta http-equiv="Content-Security-Policy"/);
    assert.match(demo.html, /<body>demo<\/body>/);

    // Step 2: the files go to a branch of their own with a pull request; confirmation every time.
    await assert.rejects(service.push(owner.id, projectId, task.id, false), /CONFIRMATION_REQUIRED/);
    const pushed = (await service.push(owner.id, projectId, task.id, true)).data;
    assert.equal(pushes[0].branch, `buildpath/agent-${task.id.slice(0, 8)}`);
    assert.equal(pushes[0].files, 5);
    assert.match(pushes[0].body, /Удалять может только администратор/);
    assert.match(pushes[0].body, /✅ Тесты проходят — `npm test`/);
    assert.match(pushes[0].body, /ИИ-агентом BuildPath/);
    assert.equal(pushed.pushed!.pullRequestUrl, 'https://github.com/owner/app/pull/7');
    assert.equal((await service.get(owner.id, projectId)).data.latest!.pushed?.branch ?? (await prisma!.agentTask.findUniqueOrThrow({ where: { id: task.id } })).pushedBranch, `buildpath/agent-${task.id.slice(0, 8)}`);
    const queued = await prisma!.agentTask.create({ data: { projectId, kind: 'build_app', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt), limits: { turns: 2, wallMs: 1000, costTiyn: null }, requestedByUserId: owner.id } });
    assert.equal((await service.stop(owner.id, projectId, queued.id)).data.status, 'stopped');
    const stranger = await prisma!.user.create({ data: { email: `x-${randomUUID()}@test.local`, emailNormalized: `x-${randomUUID()}@test.local`, passwordHash: 'x', name: 'X', locale: 'ru' } });
    users.push(stranger.id);
    await assert.rejects(service.files(stranger.id, projectId, task.id), /PROJECT_NOT_FOUND/);
  });
});
