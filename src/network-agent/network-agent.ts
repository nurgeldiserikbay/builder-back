// Pure rules of «Агент в вашей сети» (PRODUCT_LIFECYCLE §7, step 11): keys, what an agent may report, how a job result is
// read. Nothing here talks to the database or the network.
import { createHash, randomBytes } from 'node:crypto';

export const NETWORK_AGENT_KINDS = ['check', 'push', 'deploy'] as const;
export type NetworkAgentKind = (typeof NETWORK_AGENT_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';

export const NETWORK_AGENT_LIMITS = {
  /** A key lives this long; a new key can be made at any time. */
  keyDays: 180,
  /** The agent counts as online when it called within this time (it waits for jobs up to `waitMs` per call). */
  onlineMs: 90_000,
  waitMs: 25_000,
  /** A job taken and not reported in this time failed; a job nobody took in this time expired. */
  runningMs: 20 * 60_000,
  queuedMs: 60 * 60_000,
  outputChars: 4000,
  /** Jobs per project per hour, so a stuck button or script cannot flood the owner's network. */
  jobsPerHour: 30,
} as const;

/** A new key: shown once, stored only as its hash. */
export function newAgentKey(): { token: string; hash: string; hint: string } {
  const token = `bpa_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAgentKey(token), hint: token.slice(-4) };
}

export const hashAgentKey = (token: string) => createHash('sha256').update(token).digest('hex');

/** The bearer key from an Authorization header, or null when it does not look like one of ours. */
export function bearerKey(header: string | undefined): string | null {
  const match = /^Bearer (bpa_[A-Za-z0-9_-]{43})$/.exec(header?.trim() ?? '');
  return match ? match[1]! : null;
}

const clip = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max) : null);

/** An address the agent checks: its origin only, http or https, no credentials in it. */
export function agentAppOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

export interface AgentHello { version: string | null; capabilities: { check: boolean; push: boolean; deploy: boolean; shareOutput: boolean }; appUrl: string | null }

/** What an agent says about itself: only what we show the owner, nothing else is kept. */
export function readHello(raw: unknown): AgentHello {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const caps = value.capabilities && typeof value.capabilities === 'object' ? value.capabilities as Record<string, unknown> : {};
  const version = clip(value.version, 20);
  return {
    version: version && /^[0-9A-Za-z.+-]+$/.test(version) ? version : null,
    capabilities: { check: caps.check === true, push: caps.push === true, deploy: caps.deploy === true, shareOutput: caps.shareOutput === true },
    appUrl: agentAppOrigin(value.appUrl),
  };
}

export type JobResult =
  | { kind: 'check'; ok: boolean; status: number | null; database: string | null; ms: number | null; error: string | null }
  | { kind: 'push'; ok: boolean; branch: string | null; commit: string | null; error: string | null }
  | { kind: 'deploy'; ok: boolean; exitCode: number | null; output: string | null; error: string | null };

const code = (value: unknown) => (typeof value === 'string' && /^[A-Z0-9_]{2,60}$/.test(value) ? value : null);
const int = (value: unknown, max: number) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null);

/** A job's result as the agent reports it, read strictly for the job's kind; anything else is dropped. */
export function readResult(kind: NetworkAgentKind, raw: unknown): JobResult {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const ok = value.ok === true;
  const error = ok ? null : code(value.error) ?? 'AGENT_REPORTED_FAILURE';
  if (kind === 'check') {
    const database = clip(value.database, 20);
    return { kind, ok, status: int(value.status, 999), database: database && /^[a-z0-9_-]+$/.test(database) ? database : null, ms: int(value.ms, 600_000), error };
  }
  if (kind === 'push') {
    const branch = clip(value.branch, 100); const commit = clip(value.commit, 40);
    return { kind, ok, branch: branch && /^[A-Za-z0-9._/-]+$/.test(branch) ? branch : null, commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null, error };
  }
  return { kind, ok, exitCode: int(value.exitCode, 255), output: clip(value.output, NETWORK_AGENT_LIMITS.outputChars), error };
}

/** A path inside the project, safe to write in the agent's working copy. */
export function safeRepoPath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export function agentState(agent: { lastSeenAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = Date.now()): 'revoked' | 'expired' | 'waiting' | 'online' | 'offline' {
  if (agent.revokedAt) return 'revoked';
  if (agent.expiresAt.getTime() <= now) return 'expired';
  if (!agent.lastSeenAt) return 'waiting';
  return now - agent.lastSeenAt.getTime() <= NETWORK_AGENT_LIMITS.onlineMs ? 'online' : 'offline';
}
