// The agent's computer: one throwaway sandbox kept open for the whole task. Code runs only there (E2B, Firecracker microVMs);
// this process sends files and commands and reads results. The sandbox gets no platform environment and no keys.
import { tail, WORKDIR } from '../sandbox/sandbox.js';

export interface ExecResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }

export interface Workspace {
  write(path: string, content: string): Promise<void>;
  /** null when the file does not exist. */
  read(path: string): Promise<string | null>;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface WorkspaceProvider {
  readonly name: string;
  open(input: { lifetimeMs: number; internet: boolean; labels: Record<string, string> }): Promise<Workspace>;
}

export class WorkspaceError extends Error {
  constructor(readonly code: 'SANDBOX_NOT_CONFIGURED' | 'SANDBOX_START_FAILED' | 'SANDBOX_FAILED') { super(code); }
}

/** The part of the E2B SDK the workspace uses, so tests can stand in for it. */
interface E2BSession {
  files: { write(path: string, data: string): Promise<unknown>; read(path: string): Promise<string> };
  commands: { run(cmd: string, opts: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  kill(): Promise<unknown>;
}
interface E2BAgentSdk {
  create(template: string, opts: { apiKey: string; timeoutMs: number; allowInternetAccess: boolean; metadata: Record<string, string> }): Promise<E2BSession>;
  exitResult(error: unknown): { exitCode: number; stdout: string; stderr: string } | null;
  isTimeout(error: unknown): boolean;
  isNotFound(error: unknown): boolean;
}

async function realSdk(): Promise<E2BAgentSdk> {
  const e2b = await import('e2b');
  return {
    create: (template, opts) => e2b.Sandbox.create(template, opts) as unknown as Promise<E2BSession>,
    exitResult: (error) => (error instanceof e2b.CommandExitError ? { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr } : null),
    isTimeout: (error) => error instanceof e2b.TimeoutError,
    isNotFound: (error) => error instanceof e2b.NotFoundError,
  };
}

const absolute = (path: string) => `${WORKDIR}/${path}`;

export class E2BWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'e2b';
  constructor(private readonly apiKey: string, private readonly template: string, private readonly sdk: () => Promise<E2BAgentSdk> = realSdk) {}

  async open(input: { lifetimeMs: number; internet: boolean; labels: Record<string, string> }): Promise<Workspace> {
    const sdk = await this.sdk();
    let session: E2BSession;
    try {
      session = await sdk.create(this.template, { apiKey: this.apiKey, timeoutMs: input.lifetimeMs, allowInternetAccess: input.internet, metadata: input.labels });
    } catch {
      throw new WorkspaceError('SANDBOX_START_FAILED');
    }
    await session.commands.run(`mkdir -p ${WORKDIR}`, { timeoutMs: 20_000 }).catch(() => undefined);
    return {
      write: async (path, content) => { try { await session.files.write(absolute(path), content); } catch { throw new WorkspaceError('SANDBOX_FAILED'); } },
      read: async (path) => {
        try { return await session.files.read(absolute(path)); } catch (error) { if (sdk.isNotFound(error)) return null; throw new WorkspaceError('SANDBOX_FAILED'); }
      },
      exec: async (command, timeoutMs) => {
        const at = Date.now();
        try {
          // Commands get no platform environment: only CI=1 so tools behave non-interactively.
          const output = await session.commands.run(command, { cwd: WORKDIR, timeoutMs, envs: { CI: '1' } });
          return { exitCode: output.exitCode, stdout: tail(output.stdout), stderr: tail(output.stderr), timedOut: false, durationMs: Date.now() - at };
        } catch (error) {
          const exit = sdk.exitResult(error);
          if (exit) return { exitCode: exit.exitCode, stdout: tail(exit.stdout), stderr: tail(exit.stderr), timedOut: false, durationMs: Date.now() - at };
          if (sdk.isTimeout(error)) return { exitCode: null, stdout: '', stderr: '', timedOut: true, durationMs: Date.now() - at };
          throw new WorkspaceError('SANDBOX_FAILED');
        }
      },
      close: async () => { await session.kill().catch(() => undefined); },
    };
  }
}

/**
 * A sandbox server on this machine, for development and the browser end-to-end run (e2e/local-sandbox.mts): the agent's
 * commands run in that separate process, never in the API. It is refused in production and accepts only a loopback address,
 * because it is not an isolated machine.
 */
export class HttpWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'local-http';
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async open(input: { lifetimeMs: number; internet: boolean; labels: Record<string, string> }): Promise<Workspace> {
    const call = async (path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
      } catch { throw new WorkspaceError('SANDBOX_FAILED'); }
    };
    let id: string;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lifetimeMs: input.lifetimeMs }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('start');
      id = String(((await response.json()) as { id?: unknown }).id ?? '');
      if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new Error('id');
    } catch { throw new WorkspaceError('SANDBOX_START_FAILED'); }
    const files = (path: string) => `/workspaces/${id}/files?path=${encodeURIComponent(path)}`;
    return {
      write: async (path, content) => { const response = await call(files(path), { method: 'PUT', body: content }); if (!response.ok) throw new WorkspaceError('SANDBOX_FAILED'); },
      read: async (path) => {
        const response = await call(files(path));
        if (response.status === 404) return null;
        if (!response.ok) throw new WorkspaceError('SANDBOX_FAILED');
        return response.text();
      },
      exec: async (command, timeoutMs) => {
        const response = await call(`/workspaces/${id}/exec`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, timeoutMs }), timeoutMs: timeoutMs + 15_000 });
        if (!response.ok) throw new WorkspaceError('SANDBOX_FAILED');
        const result = await response.json() as ExecResult;
        return { exitCode: result.exitCode, stdout: tail(result.stdout ?? ''), stderr: tail(result.stderr ?? ''), timedOut: Boolean(result.timedOut), durationMs: Number(result.durationMs) || 0 };
      },
      close: async () => { await call(`/workspaces/${id}`, { method: 'DELETE' }).catch(() => undefined); },
    };
  }
}

/** The loopback address of a local sandbox server, or null when it is not allowed (production, or not loopback). */
export function localSandboxUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return null;
  const raw = (env.SANDBOX_HTTP_URL ?? '').trim().replace(/\/$/, '');
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null;
}

/** SANDBOX_PROVIDER=e2b with E2B_API_KEY, as for the starter checks. The agent template needs Node.js 20+ and git. */
export function configuredWorkspace(): WorkspaceProvider | null {
  const provider = process.env.SANDBOX_PROVIDER?.trim();
  if (provider === 'local-http') { const url = localSandboxUrl(); return url ? new HttpWorkspaceProvider(url) : null; }
  const key = process.env.E2B_API_KEY?.trim();
  if (provider !== 'e2b' || !key) return null;
  return new E2BWorkspaceProvider(key, process.env.AGENT_E2B_TEMPLATE?.trim() || process.env.E2B_TEMPLATE?.trim() || 'base');
}
