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

/** SANDBOX_PROVIDER=e2b with E2B_API_KEY, as for the starter checks. The agent template needs Node.js 20+ and git. */
export function configuredWorkspace(): WorkspaceProvider | null {
  const provider = process.env.SANDBOX_PROVIDER?.trim();
  const key = process.env.E2B_API_KEY?.trim();
  if (provider !== 'e2b' || !key) return null;
  return new E2BWorkspaceProvider(key, process.env.AGENT_E2B_TEMPLATE?.trim() || process.env.E2B_TEMPLATE?.trim() || 'base');
}
