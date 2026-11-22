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
import { AgentModelError, ChatCompletionsAgentModel, FallbackAgentModel, configuredAgentModel, type AgentMessage, type AgentModel, type AgentReply } from './agent-model.js';
import { blueprintProblems, deployFilesCheck, pwaCheck, runAgent, safePath, type AgentStep } from './agent-loop.js';
import { appOrigin, checkAppHealth } from './app-health.js';
import { createServer } from 'node:http';
import { AgentRunner, AgentTasksService, buildAgentPrompt, buildChangePrompt, filesDigestOf, keepAwake, keepAwakeUrl, pullRequestText, PREVIEW_CSP, promptDigestOf, withPreviewPolicy } from './agent-tasks.js';
import { JourneyCore } from '../journey/journey-core.js';
import { HttpWorkspaceProvider, localSandboxUrl, type ExecResult, type Workspace, type WorkspaceProvider } from './workspace.js';

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

/** A stand-in client build with what a phone needs to install the application. */
const PWA_BUILD = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "mkdirSync('dist/icons', { recursive: true });",
  "writeFileSync('dist/index.html', '<html><head><link rel=\"manifest\" href=\"/manifest.webmanifest\"></head><body><script src=\"/app.js\"></script></body></html>');",
  "writeFileSync('dist/manifest.webmanifest', JSON.stringify({ name: 'Учёт', short_name: 'Учёт', start_url: '/', display: 'standalone', icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/512.png', sizes: '512x512', type: 'image/png' }] }));",
  "writeFileSync('dist/icons/192.png', 'png'); writeFileSync('dist/icons/512.png', 'png');",
  "writeFileSync('dist/app.js', 'try { navigator.serviceWorker.register(\"/sw.js\"); } catch {}');",
  "writeFileSync('dist/sw.js', 'self.addEventListener(\"fetch\", () => {});');",
].join('\n');

const goodApp = [
  [{ name: 'write_file', args: { path: 'package.json', content: JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', scripts: { test: 'node --test', start: 'node server.js', build: 'node build.js', 'build:demo': "mkdir -p dist-demo && printf '<html><head><title>d</title></head><body>demo</body></html>' > dist-demo/index.html" } }) } },
    { name: 'write_file', args: { path: 'server.js', content: "import { createServer } from 'node:http';\ncreateServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/health' ? { status: 'ok', database: 'memory' } : {})); }).listen(Number(process.env.PORT));\n" } },
    { name: 'write_file', args: { path: 'render.yaml', content: 'services:\n  - type: web\n    name: app\n    runtime: node\n    buildCommand: npm ci\n    startCommand: npm run migrate && npm start\n    healthCheckPath: /api/health\n    envVars:\n      - key: DATABASE_URL\n        sync: false\n      - key: SESSION_SECRET\n        generateValue: true\n' } },
    { name: 'write_file', args: { path: 'Dockerfile', content: 'FROM node:20-alpine\nCMD ["npm","start"]\n' } },
    { name: 'write_file', args: { path: 'build.js', content: PWA_BUILD } },
    { name: 'write_file', args: { path: 'docker-compose.yml', content: 'services:\n  db:\n    image: postgres:16\n' } }],
  [{ name: 'write_file', args: { path: 'src/rules.js', content: 'export const canDelete = (role) => role === "admin";\n' } }, { name: 'write_file', args: { path: 'test/rules.test.js', content: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { canDelete } from "../src/rules.js";\ntest("admin deletes", () => { assert.equal(canDelete("admin"), true); assert.equal(canDelete("client"), false); });\n' } }],
  [{ name: 'write_file', args: { path: '../outside.txt', content: 'x' } }, { name: 'write_file', args: { path: '.env', content: 'SECRET=1' } }, { name: 'write_file', args: { path: '.env.example', content: 'SESSION_SECRET=\nDATABASE_URL=\n' } }],
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
      assert.deepEqual(outcome.checks.map((check) => [check.id, check.status]), [['install', 'passed'], ['test', 'passed'], ['build', 'passed'], ['start', 'passed'], ['deploy_files', 'passed'], ['pwa', 'passed'], ['demo', 'passed']]);
      assert.match(outcome.demoHtml!, /<body>demo<\/body>/);
      assert.deepEqual(outcome.files.map((file) => file.path).sort(), ['.env.example', 'Dockerfile', 'build.js', 'docker-compose.yml', 'package-lock.json', 'package.json', 'render.yaml', 'server.js', 'src/rules.js', 'test/rules.test.js']);
      assert.equal(outcome.turns, 5);
      assert.equal(outcome.costTiyn, 25);
      assert.ok(steps.some((step) => step.tool === 'write_file' && step.status === 'failed' && step.summary.includes('outside')), 'a path outside the project is refused');
      assert.ok(steps.some((step) => step.tool === 'run' && step.status === 'ok'));
    } finally { await workspace.close(); }
  });

  it('writes and reads many files in one call, so the application takes few model requests', async () => {
    const workspace = await localWorkspace();
    const steps: AgentStep[] = [];
    try {
      const model = scripted([
        [{ name: 'write_files', args: { files: [{ path: 'src/a.js', content: 'export const a = 1;\n' }, { path: 'src/deep/b.js', content: 'export const b = 2;\n' }, { path: '../escape.js', content: 'x' }] } }, { name: 'run', args: { command: 'ls src && ls src/deep' } }],
        [{ name: 'read_files', args: { paths: ['src/a.js', 'src/deep/b.js', 'missing.js'] } }],
        [{ name: 'finish', args: { summary: 'ok', done: [], notDone: [] } }],
      ]);
      const outcome = await runAgent({ model, workspace, system: 's', task: 't', limits: { turns: 10, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => false, onStep: async (step) => { steps.push(step); } });
      assert.equal(outcome.turns, 3);
      assert.equal(await workspace.read('src/deep/b.js'), 'export const b = 2;\n');
      // Each call gets exactly one answer; one refused path does not stop the others.
      const afterWrite = model.seen[1]!.filter((message) => message.role === 'tool');
      assert.equal(afterWrite.length, 2);
      assert.match((afterWrite[0] as { content: string }).content, /Wrote src\/a\.js[\s\S]*Wrote src\/deep\/b\.js[\s\S]*escape\.js: refused/);
      assert.match((afterWrite[1] as { content: string }).content, /a\.js[\s\S]*deep/);
      const afterRead = model.seen[2]!.at(-1) as { content: string };
      assert.match(afterRead.content, /=== src\/a\.js\nexport const a = 1;[\s\S]*=== src\/deep\/b\.js\nexport const b = 2;[\s\S]*=== missing\.js\nNo such file\./);
      assert.equal(steps.filter((step) => step.tool === 'write_file').length, 3);
      assert.ok(steps.some((step) => step.tool === 'write_file' && step.status === 'failed' && step.summary.includes('escape')));
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

  it('a launch file with a secret in it, or without a health check, fails the launch check', async () => {
    const workspace = await localWorkspace();
    try {
      await workspace.write('render.yaml', 'services:\n  - type: web\n    startCommand: npm start\n    envVars:\n      - key: DATABASE_URL\n        value: postgres://user:pass@db/app\n      - key: SESSION_SECRET\n        generateValue: true\n');
      await workspace.write('Dockerfile', 'FROM node:20\n');
      const check = await deployFilesCheck(workspace);
      assert.equal(check.status, 'failed');
      assert.match(check.output, /healthCheckPath/);
      assert.match(check.output, /secret value/);
      assert.match(check.output, /docker-compose/);
    } finally { await workspace.close(); }
  });

  it('a client that ships raw Tailwind directives fails the build and the preview', async () => {
    const workspace = await localWorkspace();
    try {
      const steps = [[{ name: 'write_file', args: { path: 'package.json', content: JSON.stringify({ name: 'app', version: '1.0.0', scripts: { build: "mkdir -p dist && printf '<style>@tailwind base;</style>' > dist/index.html", 'build:demo': "mkdir -p dist-demo && printf '<html><head><title>d</title><style>body{margin:0}</style></head><body>demo</body></html>' > dist-demo/index.html" } }) } }]];
      const outcome = await runAgent({ model: scripted(steps), workspace, system: 's', task: 't', limits: { turns: 5, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => false, onStep: async () => undefined });
      const build = outcome.checks.find((check) => check.id === 'build')!;
      assert.equal(build.status, 'failed');
      assert.match(build.output, /Styles are not processed[\s\S]*dist\/index\.html/);
      const demo = outcome.checks.find((check) => check.id === 'demo')!;
      assert.equal(demo.status, 'passed', demo.output);
    } finally { await workspace.close(); }
  });

  it('reads render.yaml as YAML: a quoted path passes, a map of services does not', () => {
    const good = 'services:\n  - type: web\n    name: master-doma\n    runtime: node\n    startCommand: "npm run migrate && npm start"\n    healthCheckPath: "/api/health"\n    envVars:\n      - key: DATABASE_URL\n        sync: false\n      - key: SESSION_SECRET\n        generateValue: true\n';
    assert.deepEqual(blueprintProblems(good), []);
    // What the agent wrote on prod: services as a map, which Render does not accept.
    assert.deepEqual(blueprintProblems('services:\n  web:\n    type: web\n    healthCheckPath: "/api/health"\n'), ['render.yaml: services must be a list (- type: web …)']);
    assert.deepEqual(blueprintProblems(good.replace('    name: master-doma\n', '')), ['render.yaml: name of the web service']);
    assert.deepEqual(blueprintProblems('services: [oops'), ['render.yaml: not valid YAML']);
    assert.deepEqual(blueprintProblems(good.replace('generateValue: true', 'value: "a-long-secret-123"')), ['render.yaml: a secret value is written in the file']);
  });

  it('an application without a manifest link, a 512 px icon or a service worker does not pass the phone check', async () => {
    const workspace = await localWorkspace();
    try {
      await workspace.write('dist/index.html', '<html><head><link rel="manifest" href="/m.json"></head></html>');
      await workspace.write('dist/m.json', JSON.stringify({ name: 'A', start_url: '/', display: 'browser', icons: [{ src: '/i.png', sizes: '192x192' }] }));
      const check = await pwaCheck(workspace);
      assert.equal(check.status, 'failed');
      assert.match(check.output, /display standalone/);
      assert.match(check.output, /512x512/);
      assert.match(check.output, /icon file dist\/i\.png/);
      assert.match(check.output, /serviceWorker\.register/);
    } finally { await workspace.close(); }
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
  it('gives back what the provider attaches to a tool call (Gemini 3 thought signatures) on the next turn', async () => {
    const bodies: Array<{ messages: Array<{ role: string; tool_calls?: Array<{ extra_content?: unknown }> }> }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const call = bodies.length === 1
        ? { id: 'g1', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig-1' } } }
        : { id: 'g2', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok","done":[],"notDone":[]}' } };
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const model = new ChatCompletionsAgentModel('k', 'gemini-3', 'https://api.test/v1', fetchImpl);
    const workspace = await localWorkspace();
    try {
      await runAgent({ model, workspace, system: 's', task: 't', limits: { turns: 5, wallMs: 60_000, costTiyn: null }, costOf: () => 0, shouldStop: async () => false, onStep: async () => undefined });
    } finally { await workspace.close(); }
    const assistant = bodies[1]!.messages.find((message) => message.role === 'assistant');
    assert.deepEqual(assistant!.tool_calls![0]!.extra_content, { google: { thought_signature: 'sig-1' } });
    // A refused request leaves its reason in the server log.
    const warn = console.warn; const logged: string[] = []; console.warn = (message: string) => { logged.push(message); };
    try {
      await assert.rejects(new ChatCompletionsAgentModel('k', 'm', 'https://api.test/v1', (async () => new Response('{"error":{"message":"Function call is missing a thought_signature"}}', { status: 400 })) as unknown as typeof fetch).next([{ role: 'user', content: 'x' }], []), /AGENT_MODEL_REJECTED/);
    } finally { console.warn = warn; }
    assert.match(logged[0]!, /answered 400: .*thought_signature/);
  });
  it('retries a slow or busy model turn and logs why', async () => {
    const warn = console.warn; const logged: string[] = []; console.warn = (message: string) => { logged.push(message); };
    try {
      let calls = 0; const bodies: Array<Record<string, unknown>> = [];
      const flaky = (async (_url: string, init: RequestInit) => {
        calls += 1; bodies.push(JSON.parse(String(init.body)));
        if (calls === 1) { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }
        if (calls === 2) return new Response('{"error":"high demand"}', { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const reply = await new ChatCompletionsAgentModel('k', 'm', 'https://api.test/v1', flaky, { retryDelaysMs: [1, 1], reasoningEffort: 'low' }).next([{ role: 'user', content: 'x' }], []);
      assert.equal(reply.text, 'ok');
      assert.equal(calls, 3);
      assert.equal(bodies[0]!.reasoning_effort, 'low');
      assert.match(logged[0]!, /did not answer in time \(attempt 1 of 3\)/);
      assert.match(logged[1]!, /answered 503: .*high demand/);
      // After the last try the task ends as unavailable; a refused request is not retried.
      let down = 0;
      await assert.rejects(new ChatCompletionsAgentModel('k', 'm', 'https://api.test/v1', (async () => { down += 1; throw new Error('ECONNRESET'); }) as unknown as typeof fetch, { retryDelaysMs: [1] }).next([{ role: 'user', content: 'x' }], []), /AGENT_MODEL_UNAVAILABLE/);
      assert.equal(down, 2);
      let refused = 0;
      await assert.rejects(new ChatCompletionsAgentModel('k', 'm', 'https://api.test/v1', (async () => { refused += 1; return new Response('bad', { status: 400 }); }) as unknown as typeof fetch, { retryDelaysMs: [1] }).next([{ role: 'user', content: 'x' }], []), /AGENT_MODEL_REJECTED/);
      assert.equal(refused, 1);
    } finally { console.warn = warn; }
    // An unknown effort value is ignored instead of being sent to the provider.
    const options = (model: unknown) => (model as { options: { reasoningEffort?: string } }).options;
    assert.equal(options(configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AGENT_MODEL: 'm', BUILDER_AGENT_REASONING_EFFORT: 'turbo' })).reasoningEffort, undefined);
    assert.equal(options(configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AGENT_MODEL: 'm', BUILDER_AGENT_REASONING_EFFORT: 'low' })).reasoningEffort, 'low');
    // The agent may use its own provider and key; the stage AI keeps its own.
    const own = configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'gemini', BUILDER_AGENT_API_KEY: 'groq', BUILDER_AGENT_BASE_URL: 'https://api.groq.com/openai/v1', BUILDER_AGENT_MODEL: 'openai/gpt-oss-120b' }) as unknown as { apiKey: string; baseUrl: string };
    assert.equal(own.apiKey, 'groq');
    assert.equal(own.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal((configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'gemini', BUILDER_AGENT_MODEL: 'm' }) as unknown as { apiKey: string }).apiKey, 'gemini');
  });
  it('moves a task to the reserve model when the main one stays unavailable, and stays there', async () => {
    const calls: string[] = []; const seen: AgentMessage[][] = [];
    const scripted = (name: string, replies: Array<AgentReply | 'down' | 'refused'>): AgentModel => ({ name: 'test', model: name, async next(messages) {
      calls.push(name); seen.push(messages);
      const next = replies.shift();
      if (next === 'down' || next === undefined) throw new AgentModelError('AGENT_MODEL_UNAVAILABLE');
      if (next === 'refused') throw new AgentModelError('AGENT_MODEL_REJECTED');
      return next;
    } });
    const ok: AgentReply = { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    const history: AgentMessage[] = [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{}' }, extra_content: { google: { thought_signature: 's' } } }] }, { role: 'tool', tool_call_id: 'a', content: 'done' }];
    const shared = new FallbackAgentModel(scripted('gemini', [ok, 'down', ok]), scripted('groq', [ok, ok]));
    const task = shared.forTask();
    assert.equal((await task.next(history, [])).text, 'ok');
    assert.equal(task.model, 'gemini');
    assert.equal((await task.next(history, [])).text, 'ok');
    assert.equal(task.model, 'groq');
    await task.next(history, []);
    assert.deepEqual(calls, ['gemini', 'gemini', 'groq', 'groq']);
    // The reserve never sees Gemini's signatures.
    assert.equal(JSON.stringify(seen[2]).includes('thought_signature'), false);
    // The next task starts on the main model again.
    const second = shared.forTask();
    assert.equal(second.model, 'gemini');
    await second.next(history, []);
    assert.equal(calls.at(-1), 'gemini');
    // A refused request is not a reason to switch.
    const strict = new FallbackAgentModel(scripted('gemini', ['refused']), scripted('groq', [ok]));
    await assert.rejects(strict.next(history, []), /AGENT_MODEL_REJECTED/);
    assert.equal(strict.model, 'gemini');
    // Settings: no reserve model means the plain main model.
    assert.ok(configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AGENT_MODEL: 'm' }) instanceof ChatCompletionsAgentModel);
    const both = configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AGENT_MODEL: 'm', BUILDER_AGENT_FALLBACK_MODEL: 'openai/gpt-oss-120b', BUILDER_AGENT_FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1', BUILDER_AGENT_FALLBACK_API_KEY: 'g' });
    assert.ok(both instanceof FallbackAgentModel);
    assert.equal(both.model, 'm');
    assert.equal((both as unknown as { reserveIsGemini: boolean }).reserveIsGemini, false);
    // Another Gemini model on the same key (its own free quota): earlier turns get Google's skip signature, and the reserve's
    // own later turns keep theirs.
    const sameKey = configuredAgentModel({ BUILDER_AI_OPENAI_API_KEY: 'k', BUILDER_AI_OPENAI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', BUILDER_AGENT_MODEL: 'gemini-3.6-flash', BUILDER_AGENT_FALLBACK_MODEL: 'gemini-3.5-flash-lite' });
    assert.equal((sameKey as unknown as { reserveIsGemini: boolean }).reserveIsGemini, true);
    assert.deepEqual((sameKey as unknown as { main: { options: { retryDelaysMs?: number[] } } }).main.options.retryDelaysMs, [15_000]);
    seen.length = 0;
    const gemini = new FallbackAgentModel(scripted('gemini', ['down']), scripted('lite', [ok, ok]), true);
    await gemini.next(history, []);
    const longer: AgentMessage[] = [...history, { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'run', arguments: '{}' }, extra_content: { google: { thought_signature: 'own' } } }] }, { role: 'tool', tool_call_id: 'b', content: 'done' }];
    await gemini.next(longer, []);
    const sent = seen.at(-1)!.filter((message) => message.role === 'assistant') as Array<{ tool_calls: Array<{ extra_content?: { google: { thought_signature: string } } }> }>;
    assert.equal(sent[0]!.tool_calls[0]!.extra_content!.google.thought_signature, 'skip_thought_signature_validator');
    assert.equal(sent[1]!.tool_calls[0]!.extra_content!.google.thought_signature, 'own');
  });
  it('keeps a free host awake while tasks run, through its own public address', async () => {
    assert.equal(keepAwakeUrl({ RENDER_EXTERNAL_URL: 'https://api.example.com/' }), 'https://api.example.com/api/v1/health');
    assert.equal(keepAwakeUrl({ BUILDER_KEEP_AWAKE_URL: 'https://own.example.com', RENDER_EXTERNAL_URL: 'https://api.example.com' }), 'https://own.example.com/api/v1/health');
    assert.equal(keepAwakeUrl({ BUILDER_KEEP_AWAKE_URL: 'off', RENDER_EXTERNAL_URL: 'https://api.example.com' }), null);
    assert.equal(keepAwakeUrl({}), null);
    const asked: string[] = [];
    const stop = keepAwake('https://api.example.com/api/v1/health', (async (url: string) => { asked.push(url); return new Response('{}'); }) as unknown as typeof fetch, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    const count = asked.length;
    assert.ok(count >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked.length, count, 'stops when the queue is empty');
  });
  it('a local sandbox server is for development only and only on a loopback address', async () => {
    assert.equal(localSandboxUrl({ SANDBOX_HTTP_URL: 'http://127.0.0.1:4570' }), 'http://127.0.0.1:4570');
    assert.equal(localSandboxUrl({ SANDBOX_HTTP_URL: 'http://127.0.0.1:4570', NODE_ENV: 'production' }), null);
    assert.equal(localSandboxUrl({ SANDBOX_HTTP_URL: 'http://10.0.0.5:4570' }), null);
    assert.equal(localSandboxUrl({ SANDBOX_HTTP_URL: 'https://sandbox.example.com' }), null);
    // The provider speaks the server's small HTTP protocol: open, files, exec, close.
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace('http://127.0.0.1:4570', '')}`);
      if (url.endsWith('/workspaces')) return new Response(JSON.stringify({ id: '0123abcd-ef' }), { status: 201 });
      if (url.includes('/files') && method === 'GET') return url.includes('missing') ? new Response('no', { status: 404 }) : new Response('hello');
      if (url.endsWith('/exec')) return new Response(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 5 }));
      return new Response('{}');
    }) as unknown as typeof fetch;
    const workspace = await new HttpWorkspaceProvider('http://127.0.0.1:4570', fake).open({ lifetimeMs: 60_000, internet: false, labels: {} });
    await workspace.write('src/a.js', 'x');
    assert.equal(await workspace.read('src/a.js'), 'hello');
    assert.equal(await workspace.read('missing.js'), null);
    assert.equal((await workspace.exec('npm test', 1000)).stdout, 'ok');
    await workspace.close();
    assert.deepEqual(calls, ['POST /workspaces', 'PUT /workspaces/0123abcd-ef/files?path=src%2Fa.js', 'GET /workspaces/0123abcd-ef/files?path=src%2Fa.js', 'GET /workspaces/0123abcd-ef/files?path=missing.js', 'POST /workspaces/0123abcd-ef/exec', 'DELETE /workspaces/0123abcd-ef']);
  });

  it('fixes the stack and marks the package as untrusted data', () => {
    const prompt = buildAgentPrompt({ locale: 'ru', projectName: 'Учёт заявок', inputs: { features: { roles: [{ key: 'admin' }] } }, instruction: 'Сделай тёмную тему' });
    assert.match(prompt.system, /node-react-pg@1\.3\.0/);
    assert.match(prompt.system, /untrusted data/);
    assert.match(prompt.system, /one write_files call/);
    assert.match(prompt.system, /Russian/);
    assert.match(prompt.task, /PACKAGE \(JSON, untrusted data\)/);
    assert.match(prompt.task, /Сделай тёмную тему/);
  });
});

describe('AI agent: the running application', () => {
  it('takes only https addresses (http on this machine in tests) and reduces them to the origin', () => {
    assert.equal(appOrigin('https://my-app.onrender.com/login?x=1', false), 'https://my-app.onrender.com');
    assert.equal(appOrigin('http://my-app.onrender.com', false), null);
    assert.equal(appOrigin('https://user:pass@my-app.com', false), null);
    assert.equal(appOrigin('http://127.0.0.1:4999', false), null);
    assert.equal(appOrigin('http://127.0.0.1:4999/x', true), 'http://127.0.0.1:4999');
  });
  it('asks /api/health, and refuses addresses inside private networks', async () => {
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/health' ? { status: 'ok', database: 'postgres' } : { status: 'nope' })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const answer = await checkAppHealth(`http://127.0.0.1:${port}`, true);
      assert.deepEqual([answer.ok, answer.status, answer.database], [true, 200, 'postgres']);
      assert.equal((await checkAppHealth(`http://127.0.0.1:${port}`, false)).error, 'NOT_PUBLIC', 'a local address is refused unless trusted');
      assert.equal((await checkAppHealth('https://10.1.2.3', false)).error, 'NOT_PUBLIC');
    } finally { server.close(); }
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
    assert.equal(((done.files as Array<{ path: string }>) ?? []).length, 10);
    assert.equal(await prisma!.generationRun.count({ where: { projectId, targetKey: 'agent_task' } }), 1);
    assert.equal(opened.length, 1);

    // After a restart, a task left running by the stopped process ends as interrupted at once.
    const orphan = await prisma!.agentTask.create({ data: { projectId, kind: 'build_app', status: 'running', startedAt: new Date(), profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt), limits: { turns: 2, wallMs: 1000, costTiyn: null }, requestedByUserId: owner.id } });
    assert.ok(await runner.recoverInterrupted() >= 1);
    assert.equal((await prisma!.agentTask.findUniqueOrThrow({ where: { id: orphan.id } })).errorCode, 'AGENT_INTERRUPTED');

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
    assert.equal(succeeded.files.length, 10);
    assert.equal(view.repository!.repoPath, 'owner/app');
    const demo = (await service.demo(owner.id, projectId, task.id)).data;
    assert.match(demo.html, /^<html><head><meta http-equiv="Content-Security-Policy"/);
    assert.match(demo.html, /<body>demo<\/body>/);

    // Step 2: the files go to a branch of their own with a pull request; confirmation every time.
    await assert.rejects(service.push(owner.id, projectId, task.id, false), /CONFIRMATION_REQUIRED/);
    const pushed = (await service.push(owner.id, projectId, task.id, true)).data;
    assert.equal(pushes[0].branch, `buildpath/agent-${task.id.slice(0, 8)}`);
    assert.equal(pushes[0].files, 10);
    assert.match(pushes[0].body, /Удалять может только администратор/);
    assert.match(pushes[0].body, /✅ Тесты проходят — `npm test`/);
    assert.match(pushes[0].body, /ИИ-агентом BuildPath/);
    assert.equal(pushed.pushed!.pullRequestUrl, 'https://github.com/owner/app/pull/7');
    assert.equal((await service.get(owner.id, projectId)).data.latest!.pushed?.branch ?? (await prisma!.agentTask.findUniqueOrThrow({ where: { id: task.id } })).pushedBranch, `buildpath/agent-${task.id.slice(0, 8)}`);
    const queued = await prisma!.agentTask.create({ data: { projectId, kind: 'build_app', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt), limits: { turns: 2, wallMs: 1000, costTiyn: null }, requestedByUserId: owner.id } });
    assert.equal((await service.stop(owner.id, projectId, queued.id)).data.status, 'stopped');
    // Step 4: the owner's address is checked and kept.
    await assert.rejects(service.checkDeployment(owner.id, projectId, 'ftp://x'), /APP_URL_INVALID/);
    const health = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok","database":"memory"}'); });
    await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', resolve));
    const before = { local: process.env.CODE_HOSTING_ALLOW_LOCAL };
    process.env.CODE_HOSTING_ALLOW_LOCAL = 'true';
    try {
      const checked = (await service.checkDeployment(owner.id, projectId, `http://127.0.0.1:${(health.address() as { port: number }).port}/app`)).data;
      assert.deepEqual([checked.ok, checked.database], [true, 'memory']);
      assert.equal((await service.get(owner.id, projectId)).data.deployment!.ok, true);
    } finally {
      health.close();
      if (before.local === undefined) delete process.env.CODE_HOSTING_ALLOW_LOCAL; else process.env.CODE_HOSTING_ALLOW_LOCAL = before.local;
    }
    // Step 5: a change starts from the files of the finished task, in the sandbox, and its pull request says what was removed.
    await assert.rejects(service.start(owner.id, projectId, { instruction: null, baseTaskId: task.id }), /CHANGE_INSTRUCTION_REQUIRED/);
    await assert.rejects(service.start(owner.id, projectId, { instruction: 'x', baseTaskId: queued.id }), /AGENT_BASE_HAS_NO_CODE/);
    await assert.rejects(service.start(owner.id, projectId, { instruction: 'x', baseTaskId: randomUUID() }), /AGENT_TASK_NOT_FOUND/);
    assert.equal((await service.get(owner.id, projectId)).data.changeBase, task.id);
    const baseFiles = (await prisma!.agentTask.findUniqueOrThrow({ where: { id: task.id } })).files as Array<{ path: string; content: string }>;
    const changePrompt = buildChangePrompt({ locale: 'ru', projectName: 'Учёт', inputs: { goal: { g: 1 } }, instruction: 'Добавь поле телефона', base: { source: 'task', taskId: task.id }, baseFiles });
    const fromRepo = buildChangePrompt({ locale: 'ru', projectName: 'Учёт', inputs: {}, instruction: 'x', base: { source: 'repository', branch: 'main', commit: 'abcdef1234567890', truncated: true }, baseFiles });
    assert.match(fromRepo.task, /repository, branch main at commit abcdef123456 — it may hold the owner's own edits/);
    assert.match(fromRepo.task, /were not copied: do not recreate or delete them/);
    assert.match(changePrompt.system, /CHANGE to an existing application/);
    assert.match(changePrompt.task, /- src\/rules\.js/);
    assert.match(changePrompt.task, /OWNER REQUEST[^\n]*\n\nДобавь поле телефона/);
    assert.match(changePrompt.task, /"goal":\{"g":1\}/);
    const seenFiles: string[] = [];
    runner.setAgent(scripted([
      [{ name: 'read_file', args: { path: 'src/rules.js' } }, { name: 'run', args: { command: 'rm src/rules.js test/rules.test.js', timeoutSeconds: 10 } }],
      [{ name: 'finish', args: { summary: 'Правила убраны.', done: ['Изменение'], notDone: [] } }],
    ]), { name: 'local', open: async () => { const ws = await localWorkspace(); const read = ws.read; ws.read = async (file) => { const content = await read(file); if (content !== null) seenFiles.push(file); return content; }; return ws; } });
    const change = await prisma!.agentTask.create({ data: {
      projectId, kind: 'change_app', instruction: 'Убери правила', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt),
      limits: { turns: 10, wallMs: 120_000, costTiyn: null }, requestedByUserId: owner.id, baseTaskId: task.id, baseFilesDigest: filesDigestOf(baseFiles as never),
    } });
    assert.equal(await runner.processNext(), true);
    const changed = await prisma!.agentTask.findUniqueOrThrow({ where: { id: change.id } });
    assert.equal(seenFiles[0], 'src/rules.js', 'the base code was in the folder when the agent read it');
    assert.equal(changed.status, 'succeeded', JSON.stringify(changed.result));
    assert.ok(!(changed.files as Array<{ path: string }>).some((file) => file.path === 'src/rules.js'));
    await service.push(owner.id, projectId, change.id, true);
    assert.match(pushes.at(-1)!.title, /изменения в «Учёт»/);
    assert.match(pushes.at(-1)!.body, /Что попросил изменить владелец:\*\* Убери правила/);
    assert.match(pushes.at(-1)!.body, /`src\/rules\.js`/);
    // From the repository: the files read at queueing are kept with the task and written into the sandbox.
    const repoFiles = [{ path: 'package.json', content: JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }) }, { path: 'OWNER_EDIT.md', content: 'правка владельца' }, { path: 'old.js', content: 'x' }];
    const seen2: string[] = [];
    runner.setAgent(scripted([
      [{ name: 'read_file', args: { path: 'OWNER_EDIT.md' } }, { name: 'run', args: { command: 'rm old.js', timeoutSeconds: 10 } }],
      [{ name: 'finish', args: { summary: 'ok', done: [], notDone: [] } }],
    ]), { name: 'local', open: async () => { const ws = await localWorkspace(); const read = ws.read; ws.read = async (file) => { const content = await read(file); if (content !== null) seen2.push(`${file}:${content}`); return content; }; return ws; } });
    const fromRepository = await prisma!.agentTask.create({ data: {
      projectId, kind: 'change_app', instruction: 'Из репозитория', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt),
      limits: { turns: 10, wallMs: 120_000, costTiyn: null }, requestedByUserId: owner.id, baseSource: 'repository', baseFiles: repoFiles, baseFilesDigest: filesDigestOf(repoFiles), baseCommit: 'c0ffee',
    } });
    await runner.processNext();
    assert.equal(seen2[0], 'OWNER_EDIT.md:правка владельца', 'the owner\'s own edit from git was in the folder');
    await service.push(owner.id, projectId, fromRepository.id, true);
    assert.match(pushes.at(-1)!.body, /`old\.js`/);
    assert.equal((await service.get(owner.id, projectId)).data.changeFromRepository, true);

    // A base whose files changed after queueing is not used.
    const stale = await prisma!.agentTask.create({ data: {
      projectId, kind: 'change_app', instruction: 'x', profile: 'x', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt, promptDigest: promptDigestOf(prompt),
      limits: { turns: 2, wallMs: 1000, costTiyn: null }, requestedByUserId: owner.id, baseTaskId: task.id, baseFilesDigest: 'e'.repeat(64),
    } });
    await runner.processNext();
    assert.equal((await prisma!.agentTask.findUniqueOrThrow({ where: { id: stale.id } })).errorCode, 'AGENT_BASE_CHANGED');
    assert.ok(pullRequestText({ taskId: 't', projectName: 'p', profile: 'x', model: null, report: null, checks: [], instruction: null }).title.includes('приложение'));
    const stranger = await prisma!.user.create({ data: { email: `x-${randomUUID()}@test.local`, emailNormalized: `x-${randomUUID()}@test.local`, passwordHash: 'x', name: 'X', locale: 'ru' } });
    users.push(stranger.id);
    await assert.rejects(service.files(stranger.id, projectId, task.id), /PROJECT_NOT_FOUND/);
  });
});
