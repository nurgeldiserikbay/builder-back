// Any git server over SSH («Свой путь», STAGE_WORK_MODEL §69): a deploy key per project, the server's host key confirmed by
// the owner, and one commit pushed with the git command-line client. Nothing from the repository is ever run: hooks are off,
// only the ssh transport is allowed, configs from the system and the home folder are ignored, and every call has a timeout.
// The address the owner typed is resolved and checked to be public; git connects to that checked IP, and the host key is
// looked up under the typed name (HostKeyAlias), so a DNS change between the check and the push cannot redirect it.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitProviderError, type GitFile } from './git-providers.js';

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** `path` is in scp form: absolute when it starts with /, otherwise relative to the login folder (as in git@host:owner/repo). */
export interface SshRemote { user: string; host: string; port: number; path: string }

const userPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const hostPattern = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const pathPattern = /^[A-Za-z0-9._~/+-]{1,300}$/;

/** git@host:owner/repo.git or ssh://user@host:port/path/repo.git. */
export function parseSshUrl(raw: string): SshRemote {
  const value = raw.trim();
  let user: string; let host: string; let port = 22; let repoPath: string;
  const full = /^ssh:\/\/([^@/]+)@(\[[0-9A-Fa-f:.]+\]|[^:/[\]]+)(?::(\d{1,5}))?\/(.+)$/.exec(value);
  const short = /^([^@/:]+)@([^:/]+):(?!\/\/)(.+)$/.exec(value);
  if (full) {
    user = full[1]; host = full[2]; port = full[3] ? Number(full[3]) : 22;
    // ssh://host/path is absolute; ssh://host/~/path is in the login folder.
    if (full[4].startsWith('~') && !full[4].startsWith('~/')) throw new GitProviderError('REPO_SSH_URL_INVALID');
    repoPath = full[4].startsWith('~/') ? full[4].slice(2) : `/${full[4]}`;
  } else if (short) {
    [, user, host, repoPath] = short;
  } else {
    throw new GitProviderError('REPO_SSH_URL_INVALID');
  }
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  const ipLike = /^[0-9.]+$/.test(host) || host.includes(':');
  const parts = repoPath.split('/').filter(Boolean);
  if (!userPattern.test(user) || (!ipLike && !hostPattern.test(host)) || !pathPattern.test(repoPath) || !parts.length || parts.some((part) => part === '..' || part.startsWith('-') || part.startsWith('~'))) {
    throw new GitProviderError('REPO_SSH_URL_INVALID');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GitProviderError('REPO_SSH_URL_INVALID');
  return { user, host, port, path: repoPath };
}

export function sshDisplayUrl(remote: SshRemote): string {
  const host = remote.host.includes(':') ? `[${remote.host}]` : remote.host;
  if (remote.port === 22) return `${remote.user}@${host}:${remote.path}`;
  return `ssh://${remote.user}@${host}:${remote.port}${remote.path.startsWith('/') ? remote.path : `/~/${remote.path}`}`;
}

let toolsChecked: Promise<boolean> | null = null;
/** git, ssh, ssh-keygen and ssh-keyscan must be installed (the API image has them; a bare dev machine may not). */
export function sshToolsAvailable(): Promise<boolean> {
  toolsChecked ??= Promise.all([run('git', ['--version']), run('ssh-keygen', ['-?']).catch((error: { code?: unknown }) => { if (error.code === 'ENOENT') throw error; }), run('ssh', ['-V']), run('ssh-keyscan', ['-?']).catch((error: { code?: unknown }) => { if (error.code === 'ENOENT') throw error; })])
    .then(() => true, () => false);
  return toolsChecked;
}

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buildpath-ssh-'));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A new ed25519 key pair in OpenSSH format; the comment names the project, not a person. */
export async function generateDeployKey(comment: string): Promise<{ publicKey: string; privateKey: string; fingerprint: string }> {
  return withTemp(async (dir) => {
    const file = path.join(dir, 'key');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment.replace(/[^A-Za-z0-9@._-]/g, '').slice(0, 60) || 'buildpath', '-f', file], { timeout: 10_000 });
    const [privateKey, publicKey] = await Promise.all([readFile(file, 'utf8'), readFile(`${file}.pub`, 'utf8')]);
    const { stdout } = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${file}.pub`], { timeout: 10_000 });
    return { publicKey: publicKey.trim(), privateKey, fingerprint: stdout.split(' ')[1] ?? '' };
  });
}

export interface HostKey { type: string; fingerprint: string; line: string }

/** The server's host keys, with SHA256 fingerprints the owner can compare with what their server shows. */
export async function scanHostKeys(remote: SshRemote, address: string): Promise<HostKey[]> {
  let stdout: string;
  try {
    ({ stdout } = await run('ssh-keyscan', ['-T', '10', '-p', String(remote.port), '-t', 'ed25519,ecdsa,rsa', address], { timeout: 20_000 }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? '';
  }
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!lines.length) throw new GitProviderError('REPO_SSH_HOST_UNREACHABLE');
  return withTemp(async (dir) => {
    const keys: HostKey[] = [];
    for (const [index, line] of lines.entries()) {
      const [, type, key] = line.split(/\s+/);
      if (!type || !key) continue;
      const file = path.join(dir, `k${index}`);
      // Stored under the name the owner typed, so ssh finds it through HostKeyAlias whatever IP the name resolves to.
      const stored = `${remote.host} ${type} ${key}`;
      await writeFile(file, `${stored}\n`);
      const { stdout: printed } = await run('ssh-keygen', ['-l', '-E', 'sha256', '-f', file], { timeout: 10_000 });
      keys.push({ type, fingerprint: printed.split(' ')[1] ?? '', line: stored });
    }
    if (!keys.length) throw new GitProviderError('REPO_SSH_HOST_UNREACHABLE');
    return keys;
  });
}

function sshErrorCode(stderr: string, pushing: boolean): string {
  const text = stderr.toLowerCase();
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) return 'REPO_SSH_HOST_KEY_CHANGED';
  if (text.includes('permission denied (publickey') || text.includes('publickey')) return 'REPO_SSH_KEY_REJECTED';
  if (text.includes('read only') || text.includes('read-only') || text.includes('write access') || (pushing && text.includes('denied'))) return 'REPO_WRITE_NOT_ALLOWED';
  if (text.includes('connection refused') || text.includes('timed out') || text.includes('no route to host') || text.includes('could not resolve')) return 'REPO_SSH_HOST_UNREACHABLE';
  if (text.includes('not found') || text.includes('does not appear to be a git repository') || text.includes('could not read from remote repository') || text.includes('does not exist')) return 'REPO_NOT_FOUND';
  if (text.includes('non-fast-forward') || text.includes('fetch first') || text.includes('rejected')) return 'REPO_SSH_PUSH_REJECTED';
  return 'REPO_PROVIDER_FAILED';
}

/** Talks to one repository with the deploy key. `address` is the checked public IP of remote.host. */
export class SshGitClient {
  constructor(private readonly remote: SshRemote, private readonly address: string, private readonly privateKey: string, private readonly knownHosts: string) {}

  /** scp form with the checked IP; the port goes to ssh (-p), so relative and absolute paths keep the meaning the owner typed. */
  private url(): string {
    const host = this.address.includes(':') ? `[${this.address}]` : this.address;
    return `${this.remote.user}@${host}:${this.remote.path}`;
  }

  private async git(dir: string, args: string[], pushing = false): Promise<string> {
    const key = path.join(dir, 'id'); const known = path.join(dir, 'known_hosts');
    const ssh = ['ssh', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlias=${this.remote.host}`, '-o', 'ConnectTimeout=15', '-p', String(this.remote.port), '-F', '/dev/null'].join(' ');
    try {
      const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'init.defaultBranch=main', ...args], {
        cwd: path.join(dir, 'repo'), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
      });
      return stdout;
    } catch (error) {
      const failure = error as { stderr?: string; killed?: boolean; code?: unknown };
      if (failure.killed) throw new GitProviderError('REPO_SSH_HOST_UNREACHABLE');
      throw new GitProviderError(sshErrorCode(failure.stderr ?? '', pushing));
    }
  }

  private async prepare<T>(work: (dir: string) => Promise<T>): Promise<T> {
    return withTemp(async (dir) => {
      await writeFile(path.join(dir, 'id'), this.privateKey.endsWith('\n') ? this.privateKey : `${this.privateKey}\n`, { mode: 0o600 });
      await writeFile(path.join(dir, 'known_hosts'), `${this.knownHosts.trim()}\n`, { mode: 0o600 });
      await mkdir(path.join(dir, 'repo'));
      return work(dir);
    });
  }

  /** Branches on the server and the one HEAD points at; proves the key can read the repository. */
  async inspect(): Promise<{ branches: string[]; defaultBranch: string | null }> {
    return this.prepare(async (dir) => {
      await this.git(dir, ['init', '-q']);
      const out = await this.git(dir, ['ls-remote', '--symref', this.url(), 'HEAD', 'refs/heads/*']);
      const branches = [...out.matchAll(/^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/gm)].map((match) => match[1]);
      const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1] ?? null;
      return { branches, defaultBranch: head };
    });
  }

  /** One commit on top of the branch (or the first commit of an empty repository), pushed without force. */
  /** from: the branch a new branch starts at (the agent's work goes on a branch made from the main one). */
  async commit(branch: string, files: GitFile[], message: string, from: string | null = null): Promise<{ commit: string }> {
    for (const name of [branch, from]) if (name !== null && (!/^[A-Za-z0-9._/-]{1,100}$/.test(name) || name.startsWith('-') || name.includes('..'))) throw new GitProviderError('REPO_BRANCH_INVALID');
    return this.prepare(async (dir) => {
      const repo = path.join(dir, 'repo');
      await this.git(dir, ['init', '-q']);
      await this.git(dir, ['remote', 'add', 'origin', this.url()]);
      const remote = await this.git(dir, ['ls-remote', 'origin', `refs/heads/${branch}`]);
      const start = remote.trim() ? branch : from && (await this.git(dir, ['ls-remote', 'origin', `refs/heads/${from}`])).trim() ? from : null;
      if (start) {
        await this.git(dir, ['fetch', '-q', '--depth=1', 'origin', `refs/heads/${start}`]);
        await this.git(dir, ['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
      } else {
        await this.git(dir, ['checkout', '-q', '--orphan', branch]);
      }
      for (const file of files) {
        if (file.path.split('/').some((part) => !part || part === '..' || part === '.git')) throw new GitProviderError('REPO_PROVIDER_FAILED');
        const target = path.join(repo, file.path);
        if (file.marker) {
          const existing = await readFile(target, 'utf8').catch(() => null);
          if (existing !== null && !existing.includes(file.marker)) throw new GitProviderError('REPO_CI_FILE_EXISTS');
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      await this.git(dir, ['add', '--', ...files.map((file) => file.path)]);
      const status = await this.git(dir, ['status', '--porcelain']);
      if (status.trim()) {
        await this.git(dir, ['-c', 'user.name=BuildPath', '-c', 'user.email=noreply@buildpath.kz', 'commit', '-q', '-m', message]);
      } else if (!start) {
        throw new GitProviderError('REPO_PROVIDER_FAILED');
      }
      await this.git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], true);
      return { commit: (await this.git(dir, ['rev-parse', 'HEAD'])).trim() };
    });
  }
}
