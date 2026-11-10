// Minimal GitHub and GitLab clients: check write access to one repository and commit a set of files.
// Errors carry safe codes; tokens never appear in messages.

export type GitProviderKey = 'github' | 'gitlab';
export type GitFile = { path: string; content: string };
export type RepoInfo = { repoPath: string; webUrl: string; defaultBranch: string; isPrivate: boolean; canWrite: boolean };

export class GitProviderError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 20_000;

async function call(fetchImpl: Fetch, url: string, token: string, init: { method?: string; body?: unknown; auth: 'bearer' | 'private' }) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.auth === 'bearer' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token }),
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
export function parseRepoUrl(provider: GitProviderKey, raw: string, allowLocal: boolean): { baseUrl: string; repoPath: string } {
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
    const base = `${this.apiUrl}/repos/${repoPath}`;
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
      actions.push({ action: existing.status === 200 ? 'update' : 'create', file_path: file.path, content: file.content });
    }
    const commit = await call(this.fetchImpl, `${project}/repository/commits`, this.token, { auth: 'private', method: 'POST', body: { branch, commit_message: message, actions } });
    if (commit.status !== 201) throw statusError(commit.status);
    return { commitUrl: String(commit.payload?.web_url ?? '') };
  }
}
