// The agent loop: the model looks, writes code, runs it, reads the errors and fixes them, until it calls finish or a limit
// stops it (turns, time, money, a stop request). Afterwards the platform runs the checks itself — the agent's own word
// that tests pass is not taken — and collects the files. Everything the model sends is untrusted: paths are confined to the
// project folder, outputs are cut, and nothing it says changes the limits.
import type { AgentMessage, AgentModel, AgentTool } from './agent-model.js';
import type { Workspace } from './workspace.js';
import { parse as parseYaml } from 'yaml';

export const AGENT_LOOP_VERSION = '1.2.0';
const FILES_PER_CALL = 30;
const OUTPUT_TO_MODEL = 8_000;
const READ_LIMIT = 60_000;
const WRITE_LIMIT = 200_000;
const COLLECT = { files: 400, bytes: 3_000_000, fileBytes: 300_000 };
/** Never sent back as the project: installed packages, build output, version control and secrets. */
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'dist-demo', 'build', 'coverage', '.next', '.cache', '.turbo', '.npm'];
/** The preview build: one self-contained HTML file the platform shows in a sandboxed frame (step 3). */
export const DEMO_PATH = 'dist-demo/index.html';
const DEMO_LIMIT = 6_000_000;

export interface AgentLimits { turns: number; wallMs: number; costTiyn: number | null }
export interface AgentStep { at: string; kind: 'note' | 'tool'; tool?: string; summary: string; status?: 'ok' | 'failed'; output?: string }
export interface AgentCheck {
  id: 'install' | 'test' | 'cases' | 'build' | 'start' | 'contract' | 'deploy_files' | 'pwa' | 'demo'; command: string; status: 'passed' | 'failed' | 'timed_out' | 'skipped'; exitCode: number | null; output: string; durationMs: number;
  /** For «cases»: the result of each test-plan case found in the test names, as the platform's own run saw it. */
  cases?: Record<string, 'passed' | 'failed'>;
  /** For «contract»: each contract operation as the platform's probe found it — passed, or why not. */
  operations?: Record<string, ContractProbeResult>;
}
/** An operation of the accepted contracts, as the platform probes it in the built application. */
export interface ContractProbe { key: string; method: string; path: string; signedIn: boolean }
export type ContractProbeResult = 'passed' | 'missing' | 'crash' | 'open' | 'accepts_empty' | 'unexpected' | 'no_answer';
export interface AgentFile { path: string; content: string }
export interface AgentOutcome {
  stopReason: 'finished' | 'turns' | 'time' | 'budget' | 'stopped' | 'model_error';
  modelErrorCode: string | null;
  report: { summary: string; done: string[]; notDone: string[] } | null;
  checks: AgentCheck[];
  files: AgentFile[];
  filesTruncated: boolean;
  /** The preview page, when npm run build:demo produced it within the limit. */
  demoHtml: string | null;
  turns: number; inputTokens: number; outputTokens: number; costTiyn: number;
}

export const AGENT_TOOLS: AgentTool[] = [
  { name: 'list_files', description: 'List project files (installed packages and build output are left out).', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'read_file', description: 'Read a text file of the project.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Path relative to the project folder' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace a text file of the project with the whole content.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'write_files', description: 'Create or replace several text files at once, each with its whole content. Prefer it to write_file: every model turn is a request the platform pays for or counts against a daily quota.', parameters: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', maxItems: FILES_PER_CALL, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['files'] } },
  { name: 'read_files', description: 'Read several text files at once.', parameters: { type: 'object', additionalProperties: false, properties: { paths: { type: 'array', maxItems: FILES_PER_CALL, items: { type: 'string' } } }, required: ['paths'] } },
  { name: 'run', description: 'Run a shell command in the project folder (npm install, npm test, node scripts). Long-running servers must be started in the background and stopped.', parameters: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 5, maximum: 600 } }, required: ['command'] } },
  { name: 'finish', description: 'Finish the task with a report for the owner, in their language.', parameters: { type: 'object', additionalProperties: false, properties: {
    summary: { type: 'string', description: 'What the application does now, 2-4 sentences, plain words' },
    done: { type: 'array', items: { type: 'string' }, description: 'Requirements that work, one line each' },
    notDone: { type: 'array', items: { type: 'string' }, description: 'Requirements not done or done partly, with the reason' },
  }, required: ['summary', 'done', 'notDone'] } },
];

/** A relative path inside the project; anything else (absolute, .., the version control folder) is refused. */
export function safePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim().replace(/^\.\/+/, '');
  if (!path || path.length > 300 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || parts[0] === '.git' || parts[0] === 'node_modules') return null;
  return path;
}

const cut = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
const lines = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 400)).filter(Boolean).slice(0, max);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface AgentRunInput {
  model: AgentModel;
  workspace: Workspace;
  system: string;
  task: string;
  limits: AgentLimits;
  costOf: (usage: { inputTokens: number | null; outputTokens: number | null }) => number;
  shouldStop: () => Promise<boolean>;
  onStep: (step: AgentStep, totals: { turns: number; costTiyn: number }) => Promise<void>;
  /** The accepted contracts' operations; the platform checks the built application against them. */
  contract?: ContractProbe[];
  now?: () => number;
}

export async function runAgent(input: AgentRunInput): Promise<AgentOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  const messages: AgentMessage[] = [{ role: 'system', content: input.system }, { role: 'user', content: input.task }];
  const totals = { turns: 0, inputTokens: 0, outputTokens: 0, costTiyn: 0 };
  let report: AgentOutcome['report'] = null;
  let stopReason: AgentOutcome['stopReason'] = 'turns';
  let modelErrorCode: string | null = null;
  const step = (value: Omit<AgentStep, 'at'>) => input.onStep({ at: new Date(now()).toISOString(), ...value }, { turns: totals.turns, costTiyn: totals.costTiyn });

  loop: while (true) {
    if (totals.turns >= input.limits.turns) { stopReason = 'turns'; break; }
    if (now() - started >= input.limits.wallMs) { stopReason = 'time'; break; }
    if (input.limits.costTiyn !== null && totals.costTiyn >= input.limits.costTiyn) { stopReason = 'budget'; break; }
    if (await input.shouldStop()) { stopReason = 'stopped'; break; }
    let reply;
    try {
      reply = await input.model.next(messages, AGENT_TOOLS);
    } catch (error) {
      modelErrorCode = (error as { code?: string }).code ?? 'AGENT_MODEL_UNAVAILABLE';
      stopReason = 'model_error';
      break;
    }
    totals.turns += 1;
    totals.inputTokens += reply.usage.inputTokens ?? 0;
    totals.outputTokens += reply.usage.outputTokens ?? 0;
    totals.costTiyn += input.costOf(reply.usage);
    messages.push({ role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments }, ...(call.extra ? { extra_content: call.extra } : {}) })) } : {}) });
    if (reply.text) await step({ kind: 'note', summary: reply.text.slice(0, 600) });
    if (!reply.toolCalls.length) {
      // A turn without tools: remind it once per turn that the work ends with finish.
      messages.push({ role: 'user', content: 'Continue with the tools. When the work is done and the checks pass, call finish.' });
      continue;
    }
    for (const call of reply.toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { args = {}; }
      const answer = (content: string) => messages.push({ role: 'tool', tool_call_id: call.id, content: cut(content, OUTPUT_TO_MODEL) });
      if (call.name === 'finish') {
        const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 1500) : '';
        report = { summary, done: lines(args.done, 40), notDone: lines(args.notDone, 40) };
        answer('Finished.');
        await step({ kind: 'tool', tool: 'finish', summary: summary.slice(0, 300) || 'finish', status: 'ok' });
        stopReason = 'finished';
        break loop;
      }
      if (call.name === 'list_files') {
        const result = await input.workspace.exec(listCommand(), 30_000);
        answer(result.stdout || '(no files yet)');
        await step({ kind: 'tool', tool: 'list_files', summary: `${result.stdout.split('\n').filter(Boolean).length} files`, status: 'ok' });
        continue;
      }
      if (call.name === 'read_file' || call.name === 'write_file' || call.name === 'read_files' || call.name === 'write_files') {
        // One file or many: each is checked and answered on its own, and one bad path does not stop the rest.
        const many = call.name.endsWith('s');
        const items: Array<{ path: unknown; content?: unknown }> = many
          ? (Array.isArray(call.name === 'write_files' ? args.files : args.paths) ? (call.name === 'write_files' ? args.files as Array<{ path: unknown; content?: unknown }> : (args.paths as unknown[]).map((path) => ({ path }))) : []).slice(0, FILES_PER_CALL)
          : [{ path: args.path, content: args.content }];
        const writing = call.name.startsWith('write');
        const tool = writing ? 'write_file' : 'read_file';
        if (!items.length) { answer('Refused: no files given.'); await step({ kind: 'tool', tool: call.name, summary: '0 files', status: 'failed' }); continue; }
        const answers: string[] = [];
        for (const item of items) {
          const path = safePath(item?.path);
          if (!path) { answers.push(`${String(item?.path ?? '').slice(0, 120)}: refused, use a relative path inside the project, not node_modules or .git.`); await step({ kind: 'tool', tool, summary: String(item?.path ?? '').slice(0, 120), status: 'failed' }); continue; }
          if (!writing) {
            const content = await input.workspace.read(path);
            const body = content === null ? 'No such file.' : content.length > READ_LIMIT ? `${content.slice(0, READ_LIMIT)}\n…(cut at ${READ_LIMIT} characters)` : content;
            answers.push(many ? `=== ${path}\n${body}` : body);
            await step({ kind: 'tool', tool, summary: path, status: content === null ? 'failed' : 'ok' });
            continue;
          }
          const content = typeof item.content === 'string' ? item.content : '';
          if (content.length > WRITE_LIMIT) { answers.push(`${path}: refused, files are limited to ${WRITE_LIMIT} characters; split it.`); await step({ kind: 'tool', tool, summary: path, status: 'failed' }); continue; }
          const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          if (folder) await input.workspace.exec(`mkdir -p ${shellQuote(folder)}`, 20_000);
          await input.workspace.write(path, content);
          answers.push(`Wrote ${path} (${content.length} characters).`);
          await step({ kind: 'tool', tool, summary: path, status: 'ok' });
        }
        // Several files read at once may be long; each keeps its own share of the answer.
        messages.push({ role: 'tool', tool_call_id: call.id, content: many && !writing ? cut(answers.join('\n\n'), READ_LIMIT) : cut(answers.join('\n'), OUTPUT_TO_MODEL) });
        continue;
      }
      if (call.name === 'run') {
        const command = typeof args.command === 'string' ? args.command.slice(0, 2000) : '';
        if (!command.trim()) { answer('Refused: empty command.'); continue; }
        const seconds = Math.min(600, Math.max(5, Number.isInteger(args.timeoutSeconds) ? Number(args.timeoutSeconds) : 300));
        const left = input.limits.wallMs - (now() - started);
        const result = await input.workspace.exec(command, Math.max(5_000, Math.min(seconds * 1000, left)));
        const output = `exit code: ${result.timedOut ? 'timed out' : result.exitCode}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`;
        answer(output);
        await step({ kind: 'tool', tool: 'run', summary: command.slice(0, 200), status: result.exitCode === 0 && !result.timedOut ? 'ok' : 'failed', output: cut(output, 1500) });
        continue;
      }
      answer(`Unknown tool ${call.name}.`);
    }
  }

  const checks = await platformChecks(input.workspace, input.contract ?? []);
  const { files, truncated } = await collectFiles(input.workspace);
  const demoHtml = checks.find((check) => check.id === 'demo')?.status === 'passed' ? await readDemo(input.workspace) : null;
  if (!demoHtml) { const demo = checks.find((check) => check.id === 'demo'); if (demo?.status === 'passed') { demo.status = 'failed'; demo.output = `${DEMO_PATH} is missing, not one file, or larger than ${DEMO_LIMIT} bytes`; } }
  return { stopReason, modelErrorCode, report, checks, files, filesTruncated: truncated, demoHtml, turns: totals.turns, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costTiyn: totals.costTiyn };
}

function listCommand(): string {
  const prune = SKIP_DIRS.map((dir) => `-name ${dir} -prune`).join(' -o ');
  return `find . \\( ${prune} \\) -o -type f -print 2>/dev/null | sed 's|^\\./||' | sort | head -${COLLECT.files}`;
}

/** The platform's own checks, whatever the agent reported: install, tests, build. A missing script is «skipped», not passed. */
export async function platformChecks(workspace: Workspace, contract: ContractProbe[] = []): Promise<AgentCheck[]> {
  const pkgText = await workspace.read('package.json');
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(pkgText ?? '{}') as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { scripts = {}; }
  const plan: Array<{ id: AgentCheck['id']; command: string; present: boolean; timeoutMs: number }> = [
    { id: 'install', command: 'npm install --no-audit --no-fund', present: pkgText !== null, timeoutMs: 600_000 },
    { id: 'test', command: 'npm test', present: typeof scripts.test === 'string' && !/no test specified/.test(String(scripts.test)), timeoutMs: 600_000 },
    { id: 'build', command: 'npm run build', present: typeof scripts.build === 'string', timeoutMs: 600_000 },
    { id: 'start', command: START_CHECK, present: typeof scripts.start === 'string', timeoutMs: 120_000 },
    { id: 'demo', command: 'npm run build:demo', present: typeof scripts['build:demo'] === 'string', timeoutMs: 600_000 },
  ];
  const results: AgentCheck[] = [];
  let failed = false;
  for (const item of plan) {
    // Right after the tests: the platform runs the test files itself, with a reporter it reads, to see each case's result.
    if (item.id === 'build') results.push(await casesCheck(workspace, results.find((check) => check.id === 'install')?.status === 'passed'));
    // The preview is built even when the main build failed: it is a separate page and does not hide that failure.
    if (!item.present || (failed && item.id !== 'demo') || (item.id === 'demo' && results[0]?.status !== 'passed')) { results.push({ id: item.id, command: item.command, status: 'skipped', exitCode: null, output: '', durationMs: 0 }); continue; }
    const result = await workspace.exec(item.command, item.timeoutMs);
    const status = result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed';
    results.push({ id: item.id, command: item.command, status, exitCode: result.exitCode, output: cut(`${result.stdout}\n${result.stderr}`.trim(), 3000), durationMs: result.durationMs });
    if (status !== 'passed' && item.id !== 'demo') failed = true;
    // The contract is probed in the started application, then the launch files are read — in the order people read the report.
    if (item.id === 'start') results.push(status === 'passed' ? await contractCheck(workspace, contract) : skippedContract());
    if (item.id === 'start') results.push(await deployFilesCheck(workspace));
  }
  if (!results.some((check) => check.id === 'contract')) results.splice(results.length - 1, 0, skippedContract());
  if (!results.some((check) => check.id === 'deploy_files')) results.splice(results.length - 1, 0, await deployFilesCheck(workspace));
  // A client that builds but ships its styles unprocessed (Tailwind directives with no Tailwind in the build) looks like bare
  // HTML: the build and the preview do not pass then. Seen on prod: the classes were there, the CSS was not.
  for (const [id, folder] of [['build', 'dist'], ['demo', 'dist-demo']] as const) {
    const check = results.find((item) => item.id === id);
    if (check?.status !== 'passed') continue;
    const raw = await workspace.exec(`grep -rlE '@tailwind[[:space:]]+(base|components|utilities)|@apply[[:space:]]' ${folder} --include='*.css' --include='*.html' 2>/dev/null | head -5`, 30_000);
    const files = raw.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (files.length) { check.status = 'failed'; check.output = cut(`${check.output}\nStyles are not processed (raw @tailwind or @apply in ${files.join(', ')}): install and configure Tailwind (tailwindcss, postcss config) or write plain CSS.`, 3000); }
  }
  // Installable on a phone: read from the built client, so it is checked only when the build passed.
  const built = results.find((check) => check.id === 'build')?.status === 'passed';
  results.splice(results.findIndex((check) => check.id === 'deploy_files') + 1, 0, built ? await pwaCheck(workspace) : { id: 'pwa', command: PWA_COMMAND, status: 'skipped', exitCode: null, output: '', durationMs: 0 });
  return results;
}

export const CASES_COMMAND = 'node --test --test-reporter=tap';
const CASE_LINE = /^\s*(not ok|ok) \d+ - .*?\[case:([a-z][a-z0-9_]{0,31})\](.*)$/;

/**
 * Results of test-plan cases from TAP output: a test whose name holds [case:<key>] proves that case. Skipped and to-do tests
 * prove nothing; a case with several tests passes only when all of them pass.
 */
export function parseCaseResults(tap: string): Record<string, 'passed' | 'failed'> {
  const out: Record<string, 'passed' | 'failed'> = {};
  for (const line of tap.split('\n')) {
    const match = CASE_LINE.exec(line);
    if (!match || /#\s*(SKIP|TODO)\b/i.test(match[3] ?? '')) continue;
    const key = match[2]!;
    out[key] = match[1] === 'ok' && out[key] !== 'failed' ? 'passed' : 'failed';
  }
  return out;
}

/** The «cases» check: informative — it says which cases passed, it does not decide whether the application passed. */
async function casesCheck(workspace: Workspace, installed: boolean): Promise<AgentCheck> {
  if (!installed) return { id: 'cases', command: CASES_COMMAND, status: 'skipped', exitCode: null, output: '', durationMs: 0 };
  const result = await workspace.exec(CASES_COMMAND, 600_000);
  const cases = parseCaseResults(result.stdout);
  const keys = Object.keys(cases);
  const failedKeys = keys.filter((key) => cases[key] === 'failed');
  return {
    id: 'cases', command: CASES_COMMAND, status: result.timedOut ? 'timed_out' : !keys.length ? 'skipped' : failedKeys.length ? 'failed' : 'passed', exitCode: result.exitCode,
    output: keys.length ? `${keys.length - failedKeys.length}/${keys.length} cases passed${failedKeys.length ? `; failed: ${failedKeys.join(', ')}` : ''}` : 'No test names hold [case:<key>].', durationMs: result.durationMs, cases,
  };
}

/**
 * Starts the application the way a host would — without a database (the profile requires the in-memory store then) — and
 * asks /api/health. The whole process group is stopped afterwards, whatever npm started.
 */
export const START_CHECK = [
  'PORT=4123 SESSION_SECRET=buildpath-start-check NODE_ENV=production setsid npm start > .buildpath-start.log 2>&1 & pid=$!',
  'ok=1; for i in $(seq 1 60); do if node -e "fetch(\'http://127.0.0.1:4123/api/health\').then(r=>r.json().then(b=>process.exit(r.ok&&b&&b.status===\'ok\'?0:1))).catch(()=>process.exit(1))"; then ok=0; break; fi; sleep 1; done',
  'kill -- -$pid 2>/dev/null; kill $pid 2>/dev/null; tail -40 .buildpath-start.log; rm -f .buildpath-start.log; exit $ok',
].join('; ');

export const CONTRACT_COMMAND = 'node .buildpath-contract.mjs';
const CONTRACT_SCRIPT = '.buildpath-contract.mjs';
const skippedContract = (): AgentCheck => ({ id: 'contract', command: CONTRACT_COMMAND, status: 'skipped', exitCode: null, output: '', durationMs: 0 });

/**
 * The probe the platform writes into the workspace (over anything the agent wrote there). It asks every operation of the
 * accepted contracts without signing in, with an empty body and a made-up id:
 * - an operation that needs a role must answer 401 — 2xx is «open» (served to anyone), 404/405 «missing», 5xx «crash»;
 * - sign-up and sign-in must refuse empty data with a 4xx — 2xx is «accepts_empty».
 * Data shapes and rules behind sign-in are the cases' job; this checks that each promised operation exists, is protected
 * as promised and does not crash.
 */
export function contractProbeScript(operations: ContractProbe[], port: number): string {
  return `const ops = ${JSON.stringify(operations.map(({ key, method, path, signedIn }) => ({ key, method, path, signedIn })))};
const base = 'http://127.0.0.1:${port}';
const id = '00000000-0000-4000-8000-000000000000';
const out = {};
for (const op of ops) {
  const url = base + op.path.replace(/\{[^}]+\}/g, id).replace(/:[A-Za-z_][A-Za-z0-9_]*/g, id);
  const withBody = ['POST', 'PUT', 'PATCH'].includes(op.method);
  let status = null;
  try {
    const response = await fetch(url, { method: op.method, redirect: 'manual', headers: { accept: 'application/json', ...(withBody ? { 'content-type': 'application/json' } : {}) }, body: withBody ? '{}' : undefined, signal: AbortSignal.timeout(10000) });
    status = response.status;
    await response.arrayBuffer().catch(() => null);
  } catch { status = null; }
  out[op.key] = status === null ? 'no_answer' : status >= 500 ? 'crash' : status === 404 || status === 405 ? 'missing'
    : op.signedIn ? (status === 401 ? 'passed' : status < 300 ? 'open' : 'unexpected')
    : (status >= 400 ? 'passed' : 'accepts_empty');
  out[op.key + '@'] = status;
}
console.log('BUILDPATH_CONTRACT ' + JSON.stringify(out));
`;
}

/** Reads the probe's line; anything else in the output is ignored. */
export function parseContractProbe(stdout: string, operations: ContractProbe[]): { operations: Record<string, ContractProbeResult>; statuses: Record<string, number | null> } {
  const line = stdout.split('\n').reverse().find((item) => item.startsWith('BUILDPATH_CONTRACT '));
  let raw: Record<string, unknown> = {};
  try { raw = line ? JSON.parse(line.slice('BUILDPATH_CONTRACT '.length)) as Record<string, unknown> : {}; } catch { raw = {}; }
  const allowed = new Set<ContractProbeResult>(['passed', 'missing', 'crash', 'open', 'accepts_empty', 'unexpected', 'no_answer']);
  const result: Record<string, ContractProbeResult> = {};
  const statuses: Record<string, number | null> = {};
  for (const operation of operations) {
    const value = raw[operation.key];
    result[operation.key] = allowed.has(value as ContractProbeResult) ? value as ContractProbeResult : 'no_answer';
    const status = raw[`${operation.key}@`];
    statuses[operation.key] = typeof status === 'number' && Number.isInteger(status) ? status : null;
  }
  return { operations: result, statuses };
}

/**
 * «contract»: informative for the whole task — an application built module by module has operations of later modules
 * missing on purpose. Each module stage reads the result for its own operations and is not accepted while they fail.
 */
async function contractCheck(workspace: Workspace, operations: ContractProbe[]): Promise<AgentCheck> {
  if (!operations.length) return skippedContract();
  const port = 4124;
  await workspace.write(CONTRACT_SCRIPT, contractProbeScript(operations, port));
  const command = [
    `PORT=${port} SESSION_SECRET=buildpath-contract-check NODE_ENV=production setsid npm start > .buildpath-contract.log 2>&1 & pid=$!`,
    `up=1; for i in $(seq 1 60); do if node -e "fetch('http://127.0.0.1:${port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then up=0; break; fi; sleep 1; done`,
    `if [ $up -eq 0 ]; then ${CONTRACT_COMMAND}; fi`,
    `kill -- -$pid 2>/dev/null; kill $pid 2>/dev/null; rm -f .buildpath-contract.log ${CONTRACT_SCRIPT}; exit $up`,
  ].join('; ');
  const result = await workspace.exec(command, 180_000);
  if (result.timedOut) return { id: 'contract', command: CONTRACT_COMMAND, status: 'timed_out', exitCode: null, output: '', durationMs: result.durationMs };
  if (result.exitCode !== 0) return { id: 'contract', command: CONTRACT_COMMAND, status: 'skipped', exitCode: result.exitCode, output: 'The application did not start for the contract check.', durationMs: result.durationMs };
  const parsed = parseContractProbe(result.stdout, operations);
  const failed = operations.filter((operation) => parsed.operations[operation.key] !== 'passed');
  return {
    id: 'contract', command: CONTRACT_COMMAND, status: failed.length ? 'failed' : 'passed', exitCode: result.exitCode, durationMs: result.durationMs, operations: parsed.operations,
    output: cut([`${operations.length - failed.length}/${operations.length} contract operations answer as promised`, ...failed.map((operation) => `${operation.method} ${operation.path}: ${parsed.operations[operation.key]}${parsed.statuses[operation.key] !== null ? ` (${parsed.statuses[operation.key]})` : ''}`)].join('\n'), 3000),
  };
}

const BLUEPRINT_SECRETS = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_PASSWORD'];

/**
 * render.yaml read as YAML, the way Render reads it: services is a list, the web service has a name, a start command and
 * healthCheckPath /api/health (quoted or not), DATABASE_URL and SESSION_SECRET are declared, and no secret has a value
 * written in the file. A text search took a quoted path for missing and a map of services for a valid Blueprint.
 */
export function blueprintProblems(text: string): string[] {
  let doc: unknown;
  try { doc = parseYaml(text, { maxAliasCount: 50 }); } catch { return ['render.yaml: not valid YAML'] as string[]; }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return ['render.yaml: services must be a list (- type: web …)'];
  const web = services.find((service): service is Record<string, unknown> => Boolean(service) && typeof service === 'object' && (service as { type?: unknown }).type === 'web');
  if (!web) return ['render.yaml: type: web'];
  const problems: string[] = [];
  if (typeof web.name !== 'string' || !web.name.trim()) problems.push('render.yaml: name of the web service');
  if (typeof web.startCommand !== 'string' || !web.startCommand.trim()) problems.push('render.yaml: startCommand');
  if (web.healthCheckPath !== '/api/health') problems.push('render.yaml: healthCheckPath: /api/health');
  const envVars = Array.isArray(web.envVars) ? web.envVars.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
  for (const key of ['DATABASE_URL', 'SESSION_SECRET']) if (!envVars.some((item) => item.key === key)) problems.push(`render.yaml: ${key}`);
  // Secrets are entered by the owner in Render, never written into the repository.
  if (envVars.some((item) => BLUEPRINT_SECRETS.includes(String(item.key)) && item.value !== undefined && String(item.value).trim() !== '')) problems.push('render.yaml: a secret value is written in the file');
  return problems;
}

/** What a host needs, checked by reading the files: a Render Blueprint, a Docker image, a compose file with a database. */
export async function deployFilesCheck(workspace: Workspace): Promise<AgentCheck> {
  const [blueprint, dockerfile, compose, envExample] = await Promise.all(['render.yaml', 'Dockerfile', 'docker-compose.yml', '.env.example'].map((path) => workspace.read(path)));
  const missing: string[] = [];
  if (!blueprint) missing.push('render.yaml');
  else missing.push(...blueprintProblems(blueprint));
  if (!dockerfile || !/^FROM\s+node:/im.test(dockerfile)) missing.push('Dockerfile (FROM node:…)');
  if (!compose || !/postgres/i.test(compose)) missing.push('docker-compose.yml with PostgreSQL');
  if (!envExample || !/DATABASE_URL/.test(envExample)) missing.push('.env.example with DATABASE_URL');
  return { id: 'deploy_files', command: 'render.yaml, Dockerfile, docker-compose.yml, .env.example', status: missing.length ? 'failed' : 'passed', exitCode: null, output: missing.length ? `Missing or wrong: ${missing.join('; ')}` : '', durationMs: 0 };
}

const PWA_COMMAND = 'dist/index.html → manifest, icons, service worker';
/** Finds the first navigator.serviceWorker.register("<path>") in the built client. */
const SW_GREP = 'grep -rhoE ' + "'serviceWorker\\.register\\(\\s*[\"'\"'\"'`][^\"'\"'\"'`]+'" + ' dist --include=*.js --include=*.html 2>/dev/null | head -1';

/**
 * Step 6: the application installs on a phone. Read from the build output: a linked web app manifest with a name, a start URL,
 * a standalone display and 192 and 512 px icons (or one SVG), the icon files, and a service worker the client registers.
 */
export async function pwaCheck(workspace: Workspace): Promise<AgentCheck> {
  const problems: string[] = [];
  const html = await workspace.read('dist/index.html');
  const inDist = (ref: string) => { const path = safePath(ref.split(/[?#]/)[0]!.replace(/^\/+/, '')); return path ? `dist/${path}` : null; };
  if (!html) problems.push('dist/index.html');
  else {
    const link = /<link[^>]+rel=["']?manifest["']?[^>]*>/i.exec(html)?.[0];
    const href = link ? /href=["']?([^"'\s>]+)/i.exec(link)?.[1] : undefined;
    const manifestPath = href && !/^[a-z]+:/i.test(href) ? inDist(href) : null;
    const text = manifestPath ? await workspace.read(manifestPath) : null;
    if (!text) problems.push('<link rel="manifest"> to a file in dist');
    else {
      let manifest: { name?: unknown; short_name?: unknown; start_url?: unknown; display?: unknown; icons?: Array<{ src?: unknown; sizes?: unknown; type?: unknown }> } = {};
      try { manifest = JSON.parse(text) as typeof manifest; } catch { problems.push('manifest is not JSON'); }
      if (typeof manifest.name !== 'string' && typeof manifest.short_name !== 'string') problems.push('manifest: name');
      if (typeof manifest.start_url !== 'string') problems.push('manifest: start_url');
      if (!['standalone', 'fullscreen', 'minimal-ui'].includes(String(manifest.display))) problems.push('manifest: display standalone');
      const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
      const has = (size: string) => icons.some((icon) => String(icon.sizes ?? '').split(/\s+/).includes(size) || (String(icon.sizes) === 'any' && /svg/.test(String(icon.type ?? icon.src))));
      if (!has('192x192') || !has('512x512')) problems.push('manifest: icons 192x192 and 512x512 (or one SVG with sizes "any")');
      for (const icon of icons.slice(0, 6)) {
        const src = typeof icon.src === 'string' && !/^[a-z]+:/i.test(icon.src) ? inDist(icon.src) : null;
        if (src && (await workspace.exec(`test -f '${src.replace(/'/g, '')}'`, 10_000)).exitCode !== 0) problems.push(`icon file ${src}`);
      }
    }
    const registered = (await workspace.exec(SW_GREP, 20_000)).stdout.trim();
    const sw = /['"`]([^'"`]+)$/.exec(registered)?.[1];
    const swPath = sw && !/^[a-z]+:/i.test(sw) ? inDist(sw) : null;
    if (!swPath) problems.push('navigator.serviceWorker.register(…) in the client');
    else if ((await workspace.exec(`test -f '${swPath.replace(/'/g, '')}'`, 10_000)).exitCode !== 0) problems.push(`service worker file ${swPath}`);
  }
  return { id: 'pwa', command: PWA_COMMAND, status: problems.length ? 'failed' : 'passed', exitCode: null, output: problems.length ? `Missing or wrong: ${problems.join('; ')}` : '', durationMs: 0 };
}

/** One HTML file with everything inline: external scripts or styles would not load in the preview frame anyway. */
async function readDemo(workspace: Workspace): Promise<string | null> {
  const html = await workspace.read(DEMO_PATH);
  if (!html || html.length > DEMO_LIMIT || !/<html[\s>]/i.test(html)) return null;
  return html;
}

export async function collectFiles(workspace: Workspace): Promise<{ files: AgentFile[]; truncated: boolean }> {
  const listed = (await workspace.exec(listCommand(), 30_000)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const files: AgentFile[] = [];
  let bytes = 0; let truncated = listed.length >= COLLECT.files;
  for (const raw of listed) {
    const path = safePath(raw);
    // Secrets and local settings never leave the sandbox as part of the project.
    if (!path || /(^|\/)\.env($|\.)(?!example)/.test(path) || /(^|\/)(id_rsa|id_ed25519)/.test(path)) continue;
    const content = await workspace.read(path);
    if (content === null || content.includes('\0')) continue;
    if (content.length > COLLECT.fileBytes || bytes + content.length > COLLECT.bytes) { truncated = true; continue; }
    bytes += content.length;
    files.push({ path, content });
  }
  return { files, truncated };
}
