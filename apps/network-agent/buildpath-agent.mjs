#!/usr/bin/env node
// BuildPath agent for a closed network («Агент в вашей сети», PRODUCT_LIFECYCLE §7).
//
// Runs inside your network and only calls out to BuildPath over HTTPS: no inbound port, no VPN. It takes three kinds of
// jobs and does them against targets you set here, with your own credentials that never leave this machine:
//   check  — asks APP_URL/api/health and reports the answer (status, database kind, time);
//   push   — sends the code of an AI-agent task to GIT_REMOTE on its own branch buildpath/agent-…;
//   deploy — runs your DEPLOY_COMMAND and reports its exit code (and its output only if SHARE_DEPLOY_OUTPUT=1).
// BuildPath never sends a command, an address or a remote: a job only says which of these to do.
//
// Needs Node.js 22 and, for push, git. Settings come from the environment:
//   BUILDPATH_URL          the BuildPath API address, e.g. https://api.example.com/api/v1 (shown when you create the key)
//   BUILDPATH_AGENT_TOKEN  the key shown once when you created it
//   APP_URL                the application's address inside your network (optional; enables check)
//   GIT_REMOTE             the internal repository, e.g. git@gitlab.corp:team/app.git (optional; enables push)
//   DEPLOY_COMMAND         your deploy command, run with sh -c (optional; enables deploy); BUILDPATH_BRANCH holds the branch
//   DEPLOY_TIMEOUT_SECONDS default 600
//   SHARE_DEPLOY_OUTPUT    1 to send the last lines of the deploy output to BuildPath (off by default: it may hold secrets)
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
const OUTPUT_CHARS = 4000;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

export function readConfig(env = process.env) {
  const problems = [];
  const api = (env.BUILDPATH_URL ?? '').replace(/\/+$/, '');
  let apiUrl = null;
  try { apiUrl = new URL(api); } catch { problems.push('BUILDPATH_URL is not an address'); }
  const local = apiUrl && (apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1');
  if (apiUrl && apiUrl.protocol !== 'https:' && !(local && env.BUILDPATH_ALLOW_HTTP === '1')) problems.push('BUILDPATH_URL must start with https://');
  const token = env.BUILDPATH_AGENT_TOKEN ?? '';
  if (!/^bpa_[A-Za-z0-9_-]{43}$/.test(token)) problems.push('BUILDPATH_AGENT_TOKEN is missing or not a BuildPath agent key');
  let appUrl = null;
  if (env.APP_URL) {
    try { const url = new URL(env.APP_URL); if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(); appUrl = url.origin; } catch { problems.push('APP_URL is not an http(s) address'); }
  }
  const timeout = Number(env.DEPLOY_TIMEOUT_SECONDS ?? 600);
  return {
    problems, api, token, appUrl,
    gitRemote: env.GIT_REMOTE || null,
    deployCommand: env.DEPLOY_COMMAND || null,
    deployTimeoutMs: (Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3600) : 600) * 1000,
    shareOutput: env.SHARE_DEPLOY_OUTPUT === '1',
    workDir: env.WORK_DIR || tmpdir(),
  };
}

/** Calls BuildPath. A refused key stops the agent: it is revoked, expired or the project is closed. */
export function client(config, fetchImpl = fetch) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${config.api}${path}`, {
      method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'user-agent': `BuildPathAgent/${VERSION}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const error = new Error(data?.message ?? `HTTP_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  };
}

const safePath = (path) => typeof path === 'string' && path.length > 0 && path.length <= 300 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\u0000')
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');

/** Runs a program without a shell; never echoes its output outward (git may print the remote with credentials). */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk) => { output = (output + chunk.toString()).slice(-20_000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = options.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); }, options.timeoutMs) : null;
    child.on('error', () => { if (timer) clearTimeout(timer); resolve({ code: null, output, failedToStart: true }); });
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code: signal ? null : code, output, timedOut: signal === 'SIGKILL' }); });
  });
}

export async function checkApp(config, fetchImpl = fetch) {
  if (!config.appUrl) return { ok: false, error: 'NO_APP_URL' };
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.appUrl}/api/health`, { headers: { accept: 'application/json', 'user-agent': `BuildPathAgent/${VERSION}` }, signal: AbortSignal.timeout(60_000), redirect: 'manual' });
    const text = (await response.text()).slice(0, 10_000);
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    const ok = response.status === 200 && parsed.status === 'ok';
    const database = typeof parsed.database === 'string' && /^[a-z0-9_-]{1,20}$/.test(parsed.database) ? parsed.database : null;
    return { ok, status: response.status, database, ms: Date.now() - started, error: ok ? null : response.status === 200 ? 'NOT_HEALTH_ANSWER' : `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, status: null, database: null, ms: Date.now() - started, error: error?.name === 'TimeoutError' ? 'APP_TIMEOUT' : 'APP_UNREACHABLE' };
  }
}

export async function pushCode(config, job, call) {
  if (!config.gitRemote) return { ok: false, error: 'NO_GIT_REMOTE' };
  const branch = job.payload?.branch;
  if (typeof branch !== 'string' || !/^buildpath\/[A-Za-z0-9._-]{1,80}$/.test(branch)) return { ok: false, error: 'BRANCH_INVALID' };
  const { files } = await call('GET', `/network-agent/jobs/${job.id}/files`);
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'NO_FILES' };
  if (files.some((file) => !safePath(file.path) || typeof file.content !== 'string')) return { ok: false, error: 'UNSAFE_PATH' };
  const removed = (Array.isArray(job.payload?.removed) ? job.payload.removed : []).filter(safePath);
  const dir = await mkdtemp(join(config.workDir, 'buildpath-push-'));
  try {
    const clone = await run('git', ['clone', '--quiet', '--depth', '1', '--', config.gitRemote, join(dir, 'repo')], { timeoutMs: 300_000 });
    if (clone.failedToStart) return { ok: false, error: 'GIT_NOT_INSTALLED' };
    if (clone.code !== 0) return { ok: false, error: 'GIT_CLONE_FAILED' };
    const repo = join(dir, 'repo');
    if ((await run('git', ['checkout', '--quiet', '-B', branch], { cwd: repo })).code !== 0) return { ok: false, error: 'GIT_BRANCH_FAILED' };
    for (const path of removed) await rm(join(repo, path), { force: true });
    for (const file of files) {
      await mkdir(dirname(join(repo, file.path)), { recursive: true });
      await writeFile(join(repo, file.path), file.content);
    }
    await run('git', ['add', '-A'], { cwd: repo });
    const message = typeof job.payload?.message === 'string' ? job.payload.message.slice(0, 200) : 'BuildPath';
    const commit = await run('git', ['-c', 'user.name=BuildPath Agent', '-c', 'user.email=agent@buildpath.invalid', 'commit', '--quiet', '--allow-empty', '-m', message], { cwd: repo });
    if (commit.code !== 0) return { ok: false, error: 'GIT_COMMIT_FAILED' };
    const push = await run('git', ['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repo, timeoutMs: 300_000 });
    if (push.code !== 0) return { ok: false, error: 'GIT_PUSH_FAILED' };
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
    return { ok: true, branch, commit: head.output.trim().slice(0, 40) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function deploy(config, job) {
  if (!config.deployCommand) return { ok: false, error: 'NO_DEPLOY_COMMAND' };
  const branch = typeof job.payload?.branch === 'string' && /^buildpath\/[A-Za-z0-9._-]{1,80}$/.test(job.payload.branch) ? job.payload.branch : '';
  const result = await run('sh', ['-c', config.deployCommand], { env: { BUILDPATH_BRANCH: branch }, timeoutMs: config.deployTimeoutMs });
  // The output may hold addresses and secrets: it leaves this machine only when you allowed it, and never with the key.
  let output = null;
  if (config.shareOutput) {
    output = result.output.slice(-OUTPUT_CHARS);
    for (const secret of [config.token, config.gitRemote].filter(Boolean)) output = output.split(secret).join('***');
  }
  if (result.timedOut) return { ok: false, exitCode: null, output, error: 'DEPLOY_TIMEOUT' };
  if (result.failedToStart) return { ok: false, exitCode: null, output, error: 'DEPLOY_NOT_STARTED' };
  return { ok: result.code === 0, exitCode: result.code, output, error: result.code === 0 ? null : 'DEPLOY_FAILED' };
}

export async function runJob(config, job, call, fetchImpl = fetch) {
  if (job.kind === 'check') return checkApp(config, fetchImpl);
  if (job.kind === 'push') return pushCode(config, job, call);
  if (job.kind === 'deploy') return deploy(config, job);
  return { ok: false, error: 'UNKNOWN_JOB' };
}

const STOP = new Set(['NETWORK_AGENT_KEY_INVALID', 'NETWORK_AGENT_KEY_REVOKED', 'NETWORK_AGENT_KEY_EXPIRED', 'NETWORK_AGENT_PROJECT_INACTIVE']);

export async function main(env = process.env) {
  const config = readConfig(env);
  if (config.problems.length) { for (const problem of config.problems) console.error(`Setting problem: ${problem}`); process.exit(2); }
  const call = client(config);
  const capabilities = { check: Boolean(config.appUrl), push: Boolean(config.gitRemote), deploy: Boolean(config.deployCommand), shareOutput: config.shareOutput };
  log(`BuildPath agent ${VERSION}: check ${capabilities.check ? 'on' : 'off'}, push ${capabilities.push ? 'on' : 'off'}, deploy ${capabilities.deploy ? 'on' : 'off'}`);
  let pause = 2000;
  let greeted = false;
  for (;;) {
    try {
      if (!greeted) { await call('POST', '/network-agent/hello', { version: VERSION, capabilities, appUrl: config.appUrl }); greeted = true; log('Connected to BuildPath, waiting for jobs.'); }
      const answer = await call('POST', '/network-agent/jobs/next', {});
      pause = 2000;
      if (!answer?.job) continue;
      const job = answer.job;
      log(`Job ${job.id}: ${job.kind}`);
      let result;
      try { result = await runJob(config, job, call); } catch { result = { ok: false, error: 'AGENT_ERROR' }; }
      log(`Job ${job.id}: ${result.ok ? 'done' : `failed (${result.error})`}`);
      await call('POST', `/network-agent/jobs/${job.id}/result`, result);
    } catch (error) {
      if (STOP.has(error?.message)) { console.error(`BuildPath refused the key (${error.message}). Create a new key on the project page; the agent stops.`); process.exit(0); }
      greeted = greeted && error?.status !== 401;
      log(`BuildPath is not reachable (${error?.message ?? 'error'}); trying again in ${Math.round(pause / 1000)} s.`);
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 60_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
