// The agent loop: the model looks, writes code, runs it, reads the errors and fixes them, until it calls finish or a limit
// stops it (turns, time, money, a stop request). Afterwards the platform runs the checks itself — the agent's own word
// that tests pass is not taken — and collects the files. Everything the model sends is untrusted: paths are confined to the
// project folder, outputs are cut, and nothing it says changes the limits.
import type { AgentMessage, AgentModel, AgentTool } from './agent-model.js';
import type { Workspace } from './workspace.js';

export const AGENT_LOOP_VERSION = '1.0.0';
const OUTPUT_TO_MODEL = 8_000;
const READ_LIMIT = 60_000;
const WRITE_LIMIT = 200_000;
const COLLECT = { files: 400, bytes: 3_000_000, fileBytes: 300_000 };
/** Never sent back as the project: installed packages, build output, version control and secrets. */
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.turbo', '.npm'];

export interface AgentLimits { turns: number; wallMs: number; costTiyn: number | null }
export interface AgentStep { at: string; kind: 'note' | 'tool'; tool?: string; summary: string; status?: 'ok' | 'failed'; output?: string }
export interface AgentCheck { id: 'install' | 'test' | 'build'; command: string; status: 'passed' | 'failed' | 'timed_out' | 'skipped'; exitCode: number | null; output: string; durationMs: number }
export interface AgentFile { path: string; content: string }
export interface AgentOutcome {
  stopReason: 'finished' | 'turns' | 'time' | 'budget' | 'stopped' | 'model_error';
  modelErrorCode: string | null;
  report: { summary: string; done: string[]; notDone: string[] } | null;
  checks: AgentCheck[];
  files: AgentFile[];
  filesTruncated: boolean;
  turns: number; inputTokens: number; outputTokens: number; costTiyn: number;
}

export const AGENT_TOOLS: AgentTool[] = [
  { name: 'list_files', description: 'List project files (installed packages and build output are left out).', parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  { name: 'read_file', description: 'Read a text file of the project.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Path relative to the project folder' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace a text file of the project with the whole content.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
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
    messages.push({ role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) } : {}) });
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
      if (call.name === 'read_file' || call.name === 'write_file') {
        const path = safePath(args.path);
        if (!path) { answer('Refused: use a relative path inside the project, not node_modules or .git.'); await step({ kind: 'tool', tool: call.name, summary: String(args.path ?? '').slice(0, 120), status: 'failed' }); continue; }
        if (call.name === 'read_file') {
          const content = await input.workspace.read(path);
          answer(content === null ? 'No such file.' : content.length > READ_LIMIT ? `${content.slice(0, READ_LIMIT)}\n…(cut at ${READ_LIMIT} characters)` : content);
          await step({ kind: 'tool', tool: 'read_file', summary: path, status: content === null ? 'failed' : 'ok' });
        } else {
          const content = typeof args.content === 'string' ? args.content : '';
          if (content.length > WRITE_LIMIT) { answer(`Refused: files are limited to ${WRITE_LIMIT} characters; split it.`); await step({ kind: 'tool', tool: 'write_file', summary: path, status: 'failed' }); continue; }
          const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          if (folder) await input.workspace.exec(`mkdir -p ${shellQuote(folder)}`, 20_000);
          await input.workspace.write(path, content);
          answer(`Wrote ${path} (${content.length} characters).`);
          await step({ kind: 'tool', tool: 'write_file', summary: path, status: 'ok' });
        }
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

  const checks = await platformChecks(input.workspace);
  const { files, truncated } = await collectFiles(input.workspace);
  return { stopReason, modelErrorCode, report, checks, files, filesTruncated: truncated, turns: totals.turns, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costTiyn: totals.costTiyn };
}

function listCommand(): string {
  const prune = SKIP_DIRS.map((dir) => `-name ${dir} -prune`).join(' -o ');
  return `find . \\( ${prune} \\) -o -type f -print 2>/dev/null | sed 's|^\\./||' | sort | head -${COLLECT.files}`;
}

/** The platform's own checks, whatever the agent reported: install, tests, build. A missing script is «skipped», not passed. */
export async function platformChecks(workspace: Workspace): Promise<AgentCheck[]> {
  const pkgText = await workspace.read('package.json');
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(pkgText ?? '{}') as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { scripts = {}; }
  const plan: Array<{ id: AgentCheck['id']; command: string; present: boolean; timeoutMs: number }> = [
    { id: 'install', command: 'npm install --no-audit --no-fund', present: pkgText !== null, timeoutMs: 600_000 },
    { id: 'test', command: 'npm test', present: typeof scripts.test === 'string' && !/no test specified/.test(String(scripts.test)), timeoutMs: 600_000 },
    { id: 'build', command: 'npm run build', present: typeof scripts.build === 'string', timeoutMs: 600_000 },
  ];
  const results: AgentCheck[] = [];
  let failed = false;
  for (const item of plan) {
    if (!item.present || failed) { results.push({ id: item.id, command: item.command, status: 'skipped', exitCode: null, output: '', durationMs: 0 }); continue; }
    const result = await workspace.exec(item.command, item.timeoutMs);
    const status = result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed';
    results.push({ id: item.id, command: item.command, status, exitCode: result.exitCode, output: cut(`${result.stdout}\n${result.stderr}`.trim(), 3000), durationMs: result.durationMs });
    if (status !== 'passed') failed = true;
  }
  return results;
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
