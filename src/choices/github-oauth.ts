// GitHub sign-in for connecting a repository with one tap (OAuth App). Only the authorization-code exchange and
// the few REST calls BuildPath needs: who the person is, repositories they can write to, and creating a new one.
import { GitProviderError } from './git-providers.js';

type Fetch = typeof fetch;
const TIMEOUT_MS = 20_000;
/** repo: write to public and private repositories the person chooses to connect. */
export const GITHUB_SCOPES = 'repo';
const repoName = /^[A-Za-z0-9_.-]{1,100}$/;

export interface GithubOauthConfig { clientId: string; clientSecret: string; webUrl: string; apiUrl: string; redirectUrl: string }

export function githubOauthConfig(env = process.env): GithubOauthConfig | null {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const api = env.PUBLIC_API_URL?.trim();
  if (!clientId || !clientSecret || !api) return null;
  return {
    clientId, clientSecret,
    webUrl: (env.GITHUB_WEB_URL ?? 'https://github.com').replace(/\/$/, ''),
    apiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    redirectUrl: `${api.replace(/\/$/, '')}/api/v1/oauth/github/callback`,
  };
}

export function authorizeUrl(config: GithubOauthConfig, state: string): string {
  const url = new URL(`${config.webUrl}/login/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUrl, scope: GITHUB_SCOPES, state, allow_signup: 'true' }).toString();
  return url.toString();
}

async function json(fetchImpl: Fetch, url: string, init: RequestInit): Promise<{ status: number; payload: unknown; scopes: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': 'BuildPath', ...init.headers } });
  } catch { throw new GitProviderError('REPO_PROVIDER_UNAVAILABLE'); }
  return { status: response.status, payload: await response.json().catch(() => null), scopes: response.headers.get('x-oauth-scopes') ?? '' };
}

export async function exchangeCode(config: GithubOauthConfig, code: string, fetchImpl: Fetch = fetch): Promise<string> {
  const { status, payload } = await json(fetchImpl, `${config.webUrl}/login/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUrl }),
  });
  const token = (payload as { access_token?: unknown } | null)?.access_token;
  if (status !== 200 || typeof token !== 'string' || !token) throw new GitProviderError('GITHUB_OAUTH_FAILED');
  return token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

export async function githubUser(config: GithubOauthConfig, token: string, fetchImpl: Fetch = fetch): Promise<{ login: string; scopes: string }> {
  const { status, payload, scopes } = await json(fetchImpl, `${config.apiUrl}/user`, { headers: auth(token) });
  const login = (payload as { login?: unknown } | null)?.login;
  if (status === 401) throw new GitProviderError('GITHUB_RECONNECT_REQUIRED');
  if (status !== 200 || typeof login !== 'string') throw new GitProviderError('REPO_PROVIDER_FAILED');
  return { login, scopes };
}

export interface GithubRepo { fullName: string; webUrl: string; isPrivate: boolean; pushedAt: string | null }

/** Repositories the person can write to, most recently updated first. */
export async function writableRepos(config: GithubOauthConfig, token: string, fetchImpl: Fetch = fetch): Promise<GithubRepo[]> {
  const { status, payload } = await json(fetchImpl, `${config.apiUrl}/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100`, { headers: auth(token) });
  if (status === 401) throw new GitProviderError('GITHUB_RECONNECT_REQUIRED');
  if (status !== 200 || !Array.isArray(payload)) throw new GitProviderError('REPO_PROVIDER_FAILED');
  return (payload as Array<Record<string, unknown>>)
    .filter((repo) => { const p = (repo.permissions ?? {}) as Record<string, unknown>; return p.push === true || p.admin === true || p.maintain === true; })
    .filter((repo) => repo.archived !== true)
    .map((repo) => ({ fullName: String(repo.full_name), webUrl: String(repo.html_url), isPrivate: repo.private === true, pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null }));
}

export function validRepoName(name: string): boolean {
  return repoName.test(name) && name !== '.' && name !== '..' && !name.endsWith('.git');
}

/** Creates an empty repository in the person's own account. */
export async function createRepo(config: GithubOauthConfig, token: string, input: { name: string; isPrivate: boolean; description: string }, fetchImpl: Fetch = fetch): Promise<GithubRepo> {
  if (!validRepoName(input.name)) throw new GitProviderError('REPO_NAME_INVALID');
  const { status, payload } = await json(fetchImpl, `${config.apiUrl}/user/repos`, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ name: input.name, private: input.isPrivate, description: input.description.slice(0, 300), auto_init: false, has_wiki: false }),
  });
  if (status === 422) throw new GitProviderError('REPO_NAME_TAKEN');
  if (status === 401) throw new GitProviderError('GITHUB_RECONNECT_REQUIRED');
  if (status !== 201 || !payload) throw new GitProviderError('REPO_PROVIDER_FAILED');
  const repo = payload as Record<string, unknown>;
  return { fullName: String(repo.full_name), webUrl: String(repo.html_url), isPrivate: repo.private === true, pushedAt: null };
}
