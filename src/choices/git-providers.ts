// Minimal GitHub, GitLab, Gitea/Forgejo and Bitbucket clients: check write access to one repository and commit a set of files.
// Errors carry safe codes; tokens never appear in messages.

/** ssh: any git server over SSH with BuildPath's deploy key (ssh-git.ts); the others are reached through their HTTPS APIs. */
export type GitProviderKey = 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'ssh';
export type ApiGitProviderKey = Exclude<GitProviderKey, 'ssh'>;
export const GIT_PROVIDERS: GitProviderKey[] = ['github', 'gitlab', 'gitea', 'bitbucket', 'ssh'];
export const gitProviderName: Record<GitProviderKey, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket', ssh: 'git (SSH)' };
/**
 * `marker`: the file is BuildPath's only when it already contains this text or does not exist. Used for files the owner may
 * already have (.gitlab-ci.yml, bitbucket-pipelines.yml): BuildPath never overwrites someone else's pipeline.
 */
export type GitFile = { path: string; content: string; marker?: string };
/** A branch made from another one; empty: the repository has no commits yet, so there is nothing to branch from. */
export interface BranchResult { created: boolean; empty: boolean }
export interface PullRequestInput { head: string; base: string; title: string; body: string }

const encodedPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
export type RepoInfo = { repoPath: string; webUrl: string; defaultBranch: string; isPrivate: boolean; canWrite: boolean };

export class GitProviderError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 20_000;

async function call(fetchImpl: Fetch, url: string, token: string, init: { method?: string; body?: unknown; auth: 'bearer' | 'private' | 'token' }) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.auth === 'bearer' ? { Authorization: `Bearer ${token}` } : init.auth === 'token' ? { Authorization: `token ${token}` } : { 'PRIVATE-TOKEN': token }),
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'BuildPath',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitProviderError('REPO_PROVIDER_UNAVAILABLE');
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  return { status: response.status, payload };
}

function statusError(status: number): GitProviderError {
  if (status === 401) return new GitProviderError('REPO_TOKEN_INVALID');
  if (status === 403) return new GitProviderError('REPO_ACCESS_DENIED');
  if (status === 404) return new GitProviderError('REPO_NOT_FOUND');
  return new GitProviderError('REPO_PROVIDER_FAILED');
}

const segment = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parses the address the user copied from the browser. GitLab may have nested groups and its own server. */
export function parseRepoUrl(provider: ApiGitProviderKey, raw: string, allowLocal: boolean): { baseUrl: string; repoPath: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new GitProviderError('REPO_URL_INVALID'); }
  const local = allowLocal && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new GitProviderError('REPO_URL_INVALID');
  if (url.username || url.password) throw new GitProviderError('REPO_URL_INVALID');
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (provider === 'github') {
    if (!local && url.hostname !== 'github.com') throw new GitProviderError('REPO_URL_NOT_GITHUB');
    if (parts.length < 2 || !segment.test(parts[0]) || !segment.test(parts[1])) throw new GitProviderError('REPO_URL_INVALID');
    return { baseUrl: `${url.protocol}//${url.host}`, repoPath: `${parts[0]}/${parts[1]}` };
  }
  if (provider === 'bitbucket') {
    if (!local && url.hostname !== 'bitbucket.org') throw new GitProviderError('REPO_URL_NOT_BITBUCKET');
    if (parts.length < 2 || !segment.test(parts[0]) || !segment.test(parts[1])) throw new GitProviderError('REPO_URL_INVALID');
    return { baseUrl: `${url.protocol}//${url.host}`, repoPath: `${parts[0]}/${parts[1]}` };
  }
  if (provider === 'gitea') {
    // Gitea, Forgejo and Codeberg: owner/repo on any server; the rest of the path (/src/branch/main) is ignored.
    if (parts.length < 2 || !segment.test(parts[0]) || !segment.test(parts[1])) throw new GitProviderError('REPO_URL_INVALID');
    return { baseUrl: `${url.protocol}//${url.host}`, repoPath: `${parts[0]}/${parts[1]}` };
  }
  const dash = parts.indexOf('-');
  const path = dash >= 0 ? parts.slice(0, dash) : parts;
  if (path.length < 2 || path.length > 10 || !path.every((item) => segment.test(item))) throw new GitProviderError('REPO_URL_INVALID');
  return { baseUrl: `${url.protocol}//${url.host}`, repoPath: path.join('/') };
}

export class GitHubClient {
  constructor(private readonly token: string, private readonly apiUrl: string, private readonly fetchImpl: Fetch = fetch) {}

  async inspect(repoPath: string): Promise<RepoInfo> {
    const { status, payload } = await call(this.fetchImpl, `${this.apiUrl}/repos/${repoPath}`, this.token, { auth: 'bearer' });
    if (status !== 200 || !payload) throw statusError(status);
    const permissions = (payload.permissions ?? {}) as { push?: boolean; admin?: boolean; maintain?: boolean };
    return {
      repoPath: String(payload.full_name ?? repoPath), webUrl: String(payload.html_url ?? ''), defaultBranch: String(payload.default_branch || 'main'),
      isPrivate: payload.private === true, canWrite: permissions.push === true || permissions.admin === true || permissions.maintain === true,
    };
  }

  /** One commit with all files on the branch. An empty repository gets its first commit through the contents API. */
  async commit(repoPath: string, branch: string, files: GitFile[], message: string): Promise<{ commitUrl: string }> {
    try {
      return await this.commitFiles(repoPath, branch, files, message);
    } catch (error) {
      // GitHub refuses workflow files to keys without the «Workflows» permission (OAuth: the workflow scope), with 403 or 404.
      if (error instanceof GitProviderError && files.some((file) => file.path.startsWith('.github/workflows/')) && ['REPO_ACCESS_DENIED', 'REPO_NOT_FOUND', 'REPO_PROVIDER_FAILED'].includes(error.code)) {
        throw new GitProviderError('REPO_WORKFLOW_PERMISSION');
      }
      throw error;
    }
  }

  private async commitFiles(repoPath: string, branch: string, files: GitFile[], message: string): Promise<{ commitUrl: string }> {
    const base = `${this.apiUrl}/repos/${repoPath}`;
    for (const file of files.filter((item) => item.marker)) {
      const existing = await call(this.fetchImpl, `${base}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, this.token, { auth: 'bearer' });
      if (existing.status === 200 && !Buffer.from(String(existing.payload?.content ?? ''), 'base64').toString('utf8').includes(file.marker!)) throw new GitProviderError('REPO_CI_FILE_EXISTS');
    }
    let ref = await call(this.fetchImpl, `${base}/git/ref/heads/${encodeURIComponent(branch)}`, this.token, { auth: 'bearer' });
    if (ref.status === 404 || ref.status === 409) {
      const [first, ...rest] = files;
      const created = await call(this.fetchImpl, `${base}/contents/${first.path.split('/').map(encodeURIComponent).join('/')}`, this.token, {
        auth: 'bearer', method: 'PUT', body: { message, branch, content: Buffer.from(first.content, 'utf8').toString('base64') },
      });
      if (created.status !== 201 && created.status !== 200) throw statusError(created.status);
      if (!rest.length) return { commitUrl: String((created.payload?.commit as { html_url?: string } | undefined)?.html_url ?? '') };
      files = rest;
      ref = await call(this.fetchImpl, `${base}/git/ref/heads/${encodeURIComponent(branch)}`, this.token, { auth: 'bearer' });
    }
    if (ref.status !== 200) throw statusError(ref.status);
    const parent = String((ref.payload?.object as { sha?: string } | undefined)?.sha ?? '');
    const parentCommit = await call(this.fetchImpl, `${base}/git/commits/${parent}`, this.token, { auth: 'bearer' });
    if (parentCommit.status !== 200) throw statusError(parentCommit.status);
    const baseTree = String((parentCommit.payload?.tree as { sha?: string } | undefined)?.sha ?? '');
    const tree = await call(this.fetchImpl, `${base}/git/trees`, this.token, {
      auth: 'bearer', method: 'POST', body: { base_tree: baseTree, tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) },
    });
    if (tree.status !== 201) throw statusError(tree.status);
    const commit = await call(this.fetchImpl, `${base}/git/commits`, this.token, { auth: 'bearer', method: 'POST', body: { message, tree: tree.payload?.sha, parents: [parent] } });
    if (commit.status !== 201) throw statusError(commit.status);
    const update = await call(this.fetchImpl, `${base}/git/refs/heads/${encodeURIComponent(branch)}`, this.token, { auth: 'bearer', method: 'PATCH', body: { sha: commit.payload?.sha, force: false } });
    if (update.status !== 200) throw statusError(update.status);
    return { commitUrl: String(commit.payload?.html_url ?? '') };
  }

  async ensureBranch(repoPath: string, branch: string, from: string): Promise<BranchResult> {
    const base = `${this.apiUrl}/repos/${repoPath}`;
    const source = await call(this.fetchImpl, `${base}/git/ref/heads/${encodedPath(from)}`, this.token, { auth: 'bearer' });
    if (source.status === 404 || source.status === 409) return { created: false, empty: true };
    if (source.status !== 200) throw statusError(source.status);
    const sha = String((source.payload?.object as { sha?: string } | undefined)?.sha ?? '');
    const created = await call(this.fetchImpl, `${base}/git/refs`, this.token, { auth: 'bearer', method: 'POST', body: { ref: `refs/heads/${branch}`, sha } });
    if (created.status === 201) return { created: true, empty: false };
    if (created.status === 422) return { created: false, empty: false };
    throw statusError(created.status);
  }

  async openPullRequest(repoPath: string, input: PullRequestInput): Promise<{ url: string }> {
    const base = `${this.apiUrl}/repos/${repoPath}`;
    const created = await call(this.fetchImpl, `${base}/pulls`, this.token, { auth: 'bearer', method: 'POST', body: { title: input.title, head: input.head, base: input.base, body: input.body } });
    if (created.status === 201) return { url: String(created.payload?.html_url ?? '') };
    if (created.status === 422) {
      // Already open for this branch: the new commit is in it.
      const owner = repoPath.split('/')[0];
      const list = await call(this.fetchImpl, `${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`, this.token, { auth: 'bearer' });
      const first = Array.isArray(list.payload) ? (list.payload as Array<{ html_url?: string }>)[0] : undefined;
      if (first?.html_url) return { url: first.html_url };
    }
    throw statusError(created.status);
  }
}

export class GitLabClient {
  private readonly api: string;
  constructor(private readonly token: string, baseUrl: string, private readonly fetchImpl: Fetch = fetch) { this.api = `${baseUrl}/api/v4`; }

  async inspect(repoPath: string): Promise<RepoInfo> {
    const { status, payload } = await call(this.fetchImpl, `${this.api}/projects/${encodeURIComponent(repoPath)}`, this.token, { auth: 'private' });
    if (status !== 200 || !payload) throw statusError(status);
    const permissions = (payload.permissions ?? {}) as { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
    const level = Math.max(permissions.project_access?.access_level ?? 0, permissions.group_access?.access_level ?? 0);
    return {
      repoPath: String(payload.path_with_namespace ?? repoPath), webUrl: String(payload.web_url ?? ''), defaultBranch: String(payload.default_branch || 'main'),
      isPrivate: payload.visibility !== 'public', canWrite: level >= 30,
    };
  }

  async commit(repoPath: string, branch: string, files: GitFile[], message: string): Promise<{ commitUrl: string }> {
    const project = `${this.api}/projects/${encodeURIComponent(repoPath)}`;
    const actions = [];
    for (const file of files) {
      const existing = await call(this.fetchImpl, `${project}/repository/files/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(branch)}`, this.token, { auth: 'private' });
      if (existing.status !== 200 && existing.status !== 404) throw statusError(existing.status);
      if (existing.status === 200 && file.marker && !Buffer.from(String(existing.payload?.content ?? ''), 'base64').toString('utf8').includes(file.marker)) throw new GitProviderError('REPO_CI_FILE_EXISTS');
      actions.push({ action: existing.status === 200 ? 'update' : 'create', file_path: file.path, content: file.content });
    }
    const commit = await call(this.fetchImpl, `${project}/repository/commits`, this.token, { auth: 'private', method: 'POST', body: { branch, commit_message: message, actions } });
    if (commit.status !== 201) throw statusError(commit.status);
    return { commitUrl: String(commit.payload?.web_url ?? '') };
  }

  async ensureBranch(repoPath: string, branch: string, from: string): Promise<BranchResult> {
    const project = `${this.api}/projects/${encodeURIComponent(repoPath)}`;
    const created = await call(this.fetchImpl, `${project}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(from)}`, this.token, { auth: 'private', method: 'POST' });
    if (created.status === 201) return { created: true, empty: false };
    if (created.status === 400 && /already exists/i.test(String(created.payload?.message ?? ''))) return { created: false, empty: false };
    if (created.status === 400 || created.status === 404) return { created: false, empty: true };
    throw statusError(created.status);
  }

  async openPullRequest(repoPath: string, input: PullRequestInput): Promise<{ url: string }> {
    const project = `${this.api}/projects/${encodeURIComponent(repoPath)}`;
    const created = await call(this.fetchImpl, `${project}/merge_requests`, this.token, { auth: 'private', method: 'POST', body: { source_branch: input.head, target_branch: input.base, title: input.title, description: input.body } });
    if (created.status === 201) return { url: String(created.payload?.web_url ?? '') };
    if (created.status === 409) {
      const list = await call(this.fetchImpl, `${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}`, this.token, { auth: 'private' });
      const first = Array.isArray(list.payload) ? (list.payload as Array<{ web_url?: string }>)[0] : undefined;
      if (first?.web_url) return { url: first.web_url };
    }
    throw statusError(created.status);
  }
}

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Gitea and Forgejo (Codeberg too): API v1 on the same server. Several files in one commit need Gitea 1.20+ or any Forgejo. */
export class GiteaClient {
  private readonly api: string;
  constructor(private readonly token: string, baseUrl: string, private readonly fetchImpl: Fetch = fetch) { this.api = `${baseUrl}/api/v1`; }

  async inspect(repoPath: string): Promise<RepoInfo> {
    const { status, payload } = await call(this.fetchImpl, `${this.api}/repos/${repoPath}`, this.token, { auth: 'token' });
    if (status !== 200 || !payload) throw statusError(status);
    const permissions = (payload.permissions ?? {}) as { push?: boolean; admin?: boolean };
    return {
      repoPath: String(payload.full_name ?? repoPath), webUrl: String(payload.html_url ?? ''), defaultBranch: String(payload.default_branch || 'main'),
      isPrivate: payload.private === true, canWrite: permissions.push === true || permissions.admin === true,
    };
  }

  async commit(repoPath: string, branch: string, files: GitFile[], message: string): Promise<{ commitUrl: string }> {
    const base = `${this.api}/repos/${repoPath}`;
    const changes = [];
    for (const file of files) {
      const existing = await call(this.fetchImpl, `${base}/contents/${encodePath(file.path)}?ref=${encodeURIComponent(branch)}`, this.token, { auth: 'token' });
      if (existing.status !== 200 && existing.status !== 404) throw statusError(existing.status);
      const sha = existing.status === 200 ? String(existing.payload?.sha ?? '') : '';
      if (sha && file.marker && !Buffer.from(String(existing.payload?.content ?? ''), 'base64').toString('utf8').includes(file.marker)) throw new GitProviderError('REPO_CI_FILE_EXISTS');
      changes.push(sha ? { operation: 'update', path: file.path, content: base64(file.content), sha } : { operation: 'create', path: file.path, content: base64(file.content) });
    }
    const commit = await call(this.fetchImpl, `${base}/contents`, this.token, { auth: 'token', method: 'POST', body: { branch, message, files: changes } });
    // Old Gitea (before 1.20) has no multi-file endpoint.
    if (commit.status === 404 || commit.status === 405) throw new GitProviderError('REPO_SERVER_TOO_OLD');
    if (commit.status !== 201 && commit.status !== 200) throw statusError(commit.status);
    return { commitUrl: String((commit.payload?.commit as { html_url?: string } | undefined)?.html_url ?? '') };
  }

  async ensureBranch(repoPath: string, branch: string, from: string): Promise<BranchResult> {
    const created = await call(this.fetchImpl, `${this.api}/repos/${repoPath}/branches`, this.token, { auth: 'token', method: 'POST', body: { new_branch_name: branch, old_branch_name: from } });
    if (created.status === 201) return { created: true, empty: false };
    if (created.status === 409) return { created: false, empty: false };
    if (created.status === 404) return { created: false, empty: true };
    throw statusError(created.status);
  }

  async openPullRequest(repoPath: string, input: PullRequestInput): Promise<{ url: string }> {
    const created = await call(this.fetchImpl, `${this.api}/repos/${repoPath}/pulls`, this.token, { auth: 'token', method: 'POST', body: { head: input.head, base: input.base, title: input.title, body: input.body } });
    if (created.status === 201) return { url: String(created.payload?.html_url ?? '') };
    if (created.status === 409) {
      const list = await call(this.fetchImpl, `${this.api}/repos/${repoPath}/pulls?state=open`, this.token, { auth: 'token' });
      const match = Array.isArray(list.payload) ? (list.payload as Array<{ html_url?: string; head?: { ref?: string } }>).find((item) => item.head?.ref === input.head) : undefined;
      if (match?.html_url) return { url: match.html_url };
    }
    throw statusError(created.status);
  }
}

/**
 * Bitbucket Cloud with a repository access token (Bearer). Bitbucket does not say whether a token can write, so a token that
 * reads the repository is accepted and writing is confirmed by the first push.
 */
export class BitbucketClient {
  constructor(private readonly token: string, private readonly apiUrl: string, private readonly fetchImpl: Fetch = fetch) {}

  async inspect(repoPath: string): Promise<RepoInfo> {
    const { status, payload } = await call(this.fetchImpl, `${this.apiUrl}/repositories/${repoPath}`, this.token, { auth: 'bearer' });
    if (status !== 200 || !payload) throw statusError(status);
    const links = (payload.links ?? {}) as { html?: { href?: string } };
    const main = payload.mainbranch as { name?: string } | null | undefined;
    return {
      repoPath: String(payload.full_name ?? repoPath), webUrl: String(links.html?.href ?? `https://bitbucket.org/${repoPath}`), defaultBranch: String(main?.name || 'main'),
      isPrivate: payload.is_private !== false, canWrite: true,
    };
  }

  private async raw(url: string): Promise<{ status: number; text: string }> {
    try {
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': 'BuildPath' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: response.status, text: response.status === 200 ? await response.text() : '' };
    } catch {
      throw new GitProviderError('REPO_PROVIDER_UNAVAILABLE');
    }
  }

  async commit(repoPath: string, branch: string, files: GitFile[], message: string): Promise<{ commitUrl: string }> {
    const base = `${this.apiUrl}/repositories/${repoPath}`;
    for (const file of files.filter((item) => item.marker)) {
      const existing = await this.raw(`${base}/src/${encodeURIComponent(branch)}/${encodePath(file.path)}`);
      if (existing.status === 200 && !existing.text.includes(file.marker!)) throw new GitProviderError('REPO_CI_FILE_EXISTS');
      if (existing.status !== 200 && existing.status !== 404) throw statusError(existing.status);
    }
    const form = new FormData();
    form.append('message', message);
    form.append('branch', branch);
    for (const file of files) form.append(file.path, new Blob([file.content], { type: 'text/plain' }), file.path.split('/').pop());
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/src`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': 'BuildPath' }, body: form, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GitProviderError('REPO_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 403) throw new GitProviderError('REPO_WRITE_NOT_ALLOWED');
    if (response.status !== 201) throw statusError(response.status);
    const location = response.headers.get('location') ?? '';
    const sha = /\/commit\/([0-9a-f]{7,40})/.exec(location)?.[1];
    return { commitUrl: sha ? `https://bitbucket.org/${repoPath}/commits/${sha}` : `https://bitbucket.org/${repoPath}/commits/branch/${encodeURIComponent(branch)}` };
  }

  async ensureBranch(repoPath: string, branch: string, from: string): Promise<BranchResult> {
    const base = `${this.apiUrl}/repositories/${repoPath}`;
    const source = await call(this.fetchImpl, `${base}/refs/branches/${encodedPath(from)}`, this.token, { auth: 'bearer' });
    if (source.status === 404) return { created: false, empty: true };
    if (source.status !== 200) throw statusError(source.status);
    const hash = String((source.payload?.target as { hash?: string } | undefined)?.hash ?? '');
    const created = await call(this.fetchImpl, `${base}/refs/branches`, this.token, { auth: 'bearer', method: 'POST', body: { name: branch, target: { hash } } });
    if (created.status === 201) return { created: true, empty: false };
    if (created.status === 400 || created.status === 409) return { created: false, empty: false };
    throw statusError(created.status);
  }

  async openPullRequest(repoPath: string, input: PullRequestInput): Promise<{ url: string }> {
    const base = `${this.apiUrl}/repositories/${repoPath}`;
    const created = await call(this.fetchImpl, `${base}/pullrequests`, this.token, { auth: 'bearer', method: 'POST', body: {
      title: input.title, description: input.body, source: { branch: { name: input.head } }, destination: { branch: { name: input.base } },
    } });
    if (created.status === 201) return { url: String((created.payload?.links as { html?: { href?: string } } | undefined)?.html?.href ?? '') };
    if (created.status === 400) {
      const list = await call(this.fetchImpl, `${base}/pullrequests?state=OPEN&q=${encodeURIComponent(`source.branch.name="${input.head}"`)}`, this.token, { auth: 'bearer' });
      const first = ((list.payload?.values ?? []) as Array<{ links?: { html?: { href?: string } } }>)[0];
      if (first?.links?.html?.href) return { url: first.links.html.href };
    }
    throw statusError(created.status);
  }
}
