/**
 * Isolated execution of generated code. Code never runs in the API or web process: a provider starts a
 * throwaway virtual machine, writes the files, runs the commands and is destroyed. The first provider is
 * E2B (Firecracker microVMs, pay per second); another one plugs in behind the same interface.
 */
export interface SandboxFile { path: string; content: string }
export interface SandboxCommand { id: string; run: string; timeoutMs: number }
export interface SandboxRequest {
  files: SandboxFile[];
  commands: SandboxCommand[];
  /** Whether the machine may reach the internet; off for code that needs no packages. */
  internet: boolean;
  /** Hard limit for the whole machine, after which the provider destroys it. */
  lifetimeMs: number;
  /** Labels the provider shows in its console, for tracing; never personal data. */
  labels: Record<string, string>;
}
export type SandboxCommandStatus = 'passed' | 'failed' | 'timed_out' | 'skipped';
export interface SandboxCommandResult { id: string; status: SandboxCommandStatus; exitCode: number | null; durationMs: number; stdout: string; stderr: string }
export interface SandboxResult { provider: string; commands: SandboxCommandResult[]; durationMs: number }

export interface SandboxProvider {
  readonly name: string;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

export class SandboxError extends Error {
  constructor(readonly code: 'SANDBOX_NOT_CONFIGURED' | 'SANDBOX_START_FAILED' | 'SANDBOX_UPLOAD_FAILED' | 'SANDBOX_FAILED') { super(code); }
}

export const WORKDIR = '/home/user/project';
const TAIL = 6000;
// Colour codes and other terminal control sequences are noise in a report.
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const tail = (value: string | undefined) => {
  const clean = (value ?? '').replace(CONTROL, '');
  return clean.length > TAIL ? `…${clean.slice(-TAIL)}` : clean;
};

/** The part of the E2B SDK the adapter uses, so tests can stand in for it. */
export interface E2BCommandResult { exitCode: number; stdout: string; stderr: string; error?: string }
export interface E2BSandboxLike {
  files: { write(files: Array<{ path: string; data: string }>): Promise<unknown> };
  commands: { run(cmd: string, opts: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }): Promise<E2BCommandResult> };
  kill(): Promise<unknown>;
}
export interface E2BSdk {
  create(template: string, opts: { apiKey: string; timeoutMs: number; allowInternetAccess: boolean; metadata: Record<string, string> }): Promise<E2BSandboxLike>;
  /** True when the error means the command ran but exited non-zero; its result is attached. */
  exitResult(error: unknown): E2BCommandResult | null;
  isTimeout(error: unknown): boolean;
}

async function realSdk(): Promise<E2BSdk> {
  const e2b = await import('e2b');
  return {
    create: (template, opts) => e2b.Sandbox.create(template, opts) as unknown as Promise<E2BSandboxLike>,
    exitResult: (error) => (error instanceof e2b.CommandExitError ? { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr, error: error.error } : null),
    isTimeout: (error) => error instanceof e2b.TimeoutError,
  };
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = 'e2b';
  constructor(private readonly apiKey: string, private readonly template: string, private readonly sdk: () => Promise<E2BSdk> = realSdk) {}

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const started = Date.now();
    const sdk = await this.sdk();
    let sandbox: E2BSandboxLike;
    try {
      sandbox = await sdk.create(this.template, { apiKey: this.apiKey, timeoutMs: request.lifetimeMs, allowInternetAccess: request.internet, metadata: request.labels });
    } catch {
      throw new SandboxError('SANDBOX_START_FAILED');
    }
    try {
      try {
        await sandbox.files.write(request.files.map((file) => ({ path: `${WORKDIR}/${file.path}`, data: file.content })));
      } catch {
        throw new SandboxError('SANDBOX_UPLOAD_FAILED');
      }
      const results: SandboxCommandResult[] = [];
      let stop = false;
      for (const command of request.commands) {
        if (stop) { results.push({ id: command.id, status: 'skipped', exitCode: null, durationMs: 0, stdout: '', stderr: '' }); continue; }
        const at = Date.now();
        try {
          // Commands get no platform environment: only CI=1 so tools behave non-interactively.
          const output = await sandbox.commands.run(command.run, { cwd: WORKDIR, timeoutMs: command.timeoutMs, envs: { CI: '1' } });
          results.push({ id: command.id, status: output.exitCode === 0 ? 'passed' : 'failed', exitCode: output.exitCode, durationMs: Date.now() - at, stdout: tail(output.stdout), stderr: tail(output.stderr) });
        } catch (error) {
          const exit = sdk.exitResult(error);
          if (exit) results.push({ id: command.id, status: 'failed', exitCode: exit.exitCode, durationMs: Date.now() - at, stdout: tail(exit.stdout), stderr: tail(exit.stderr) });
          else if (sdk.isTimeout(error)) results.push({ id: command.id, status: 'timed_out', exitCode: null, durationMs: Date.now() - at, stdout: '', stderr: '' });
          else throw new SandboxError('SANDBOX_FAILED');
        }
        stop = results[results.length - 1]!.status !== 'passed';
      }
      return { provider: this.name, commands: results, durationMs: Date.now() - started };
    } finally {
      await sandbox.kill().catch(() => undefined);
    }
  }
}

/** SANDBOX_PROVIDER=e2b with E2B_API_KEY; without them checks report «not configured» rather than pretending. */
export function configuredSandbox(): SandboxProvider | null {
  const provider = process.env.SANDBOX_PROVIDER?.trim();
  const key = process.env.E2B_API_KEY?.trim();
  if (provider !== 'e2b' || !key) return null;
  return new E2BSandboxProvider(key, process.env.E2B_TEMPLATE?.trim() || 'base');
}
