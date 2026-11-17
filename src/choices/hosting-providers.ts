// External static hosting for the accepted site (deployment card): Netlify and Vercel. One interface for every provider, so
// adding Cloudflare Pages later is one more class here. Each deploy is an explicit owner action with confirmation; BuildPath sends
// only the accepted, self-contained page (images inline), never project data or secrets.
import { createHash } from 'node:crypto';

export type HostingProviderKey = 'netlify' | 'vercel';
export const HOSTING_PROVIDERS: HostingProviderKey[] = ['netlify', 'vercel'];
export const hostingProviderName: Record<string, string> = { netlify: 'Netlify', vercel: 'Vercel' };

export interface HostedSite { siteId: string; url: string; adminUrl: string | null }
export interface HostingDeploy { deployId: string; url: string; state: string }
export interface HostingFile { path: string; content: string }

export class HostingError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface HostingProvider {
  readonly key: HostingProviderKey;
  /** Confirms the token works; returns the account name to show the owner. */
  verify(): Promise<{ account: string }>;
  /** An existing site the token can deploy to, or a new one. */
  site(siteId: string | null, name: string): Promise<HostedSite>;
  deploy(siteId: string, files: HostingFile[]): Promise<HostingDeploy>;
}

type Fetch = typeof fetch;
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

/** Netlify: digest deploys — the deploy lists file hashes, Netlify asks only for files it does not have, those are uploaded. */
export class NetlifyProvider implements HostingProvider {
  readonly key = 'netlify' as const;
  constructor(private readonly token: string, private readonly fetchImpl: Fetch = fetch, private readonly baseUrl = process.env.NETLIFY_API_URL || 'https://api.netlify.com/api/v1') {}

  private async call<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': contentType, 'user-agent': 'BuildPath' },
        body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body as string,
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HostingError('HOSTING_UNAVAILABLE');
    }
    if (response.status === 401 || response.status === 403) throw new HostingError('HOSTING_TOKEN_INVALID');
    if (response.status === 404) throw new HostingError('HOSTING_SITE_NOT_FOUND');
    if (response.status === 422) throw new HostingError('HOSTING_SITE_NAME_TAKEN');
    if (response.status === 429) throw new HostingError('HOSTING_RATE_LIMITED');
    if (!response.ok) throw new HostingError('HOSTING_FAILED');
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async verify() {
    const user = await this.call<{ email?: string; full_name?: string; slug?: string }>('GET', '/user');
    return { account: user.full_name || user.slug || user.email || 'Netlify' };
  }

  async site(siteId: string | null, name: string): Promise<HostedSite> {
    type Site = { id: string; ssl_url?: string; url?: string; admin_url?: string };
    if (siteId) {
      if (!/^[A-Za-z0-9-]{3,80}$/.test(siteId)) throw new HostingError('HOSTING_SITE_NOT_FOUND');
      const site = await this.call<Site>('GET', `/sites/${encodeURIComponent(siteId)}`);
      return { siteId: site.id, url: site.ssl_url || site.url || '', adminUrl: site.admin_url ?? null };
    }
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    // A random tail keeps the address free; Netlify answers 422 for a taken name.
    const site = await this.call<Site>('POST', '/sites', { name: `${slug || 'site'}-${Math.random().toString(36).slice(2, 8)}` });
    return { siteId: site.id, url: site.ssl_url || site.url || '', adminUrl: site.admin_url ?? null };
  }

  async deploy(siteId: string, files: HostingFile[]): Promise<HostingDeploy> {
    const digests = Object.fromEntries(files.map((file) => [`/${file.path.replace(/^\/+/, '')}`, sha1(file.content)]));
    const created = await this.call<{ id: string; required?: string[]; ssl_url?: string; deploy_ssl_url?: string; url?: string; state?: string }>('POST', `/sites/${encodeURIComponent(siteId)}/deploys`, { files: digests });
    const required = new Set(created.required ?? []);
    for (const file of files) {
      if (!required.has(sha1(file.content))) continue;
      await this.call('PUT', `/deploys/${encodeURIComponent(created.id)}/files/${file.path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`, file.content, 'application/octet-stream');
    }
    return { deployId: created.id, url: created.ssl_url || created.url || created.deploy_ssl_url || '', state: created.state ?? 'uploaded' };
  }
}

/**
 * Vercel: a project per site and production deployments with the files inline (no build step). The site address is the
 * project's production domain, имя.vercel.app. Requests go to the token's default team.
 */
export class VercelProvider implements HostingProvider {
  readonly key = 'vercel' as const;
  private teamId: string | null | undefined;
  constructor(private readonly token: string, private readonly fetchImpl: Fetch = fetch, private readonly baseUrl = process.env.VERCEL_API_URL || 'https://api.vercel.com') {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const team = this.teamId ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.teamId)}` : '';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}${team}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'user-agent': 'BuildPath' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HostingError('HOSTING_UNAVAILABLE');
    }
    if (response.status === 401 || response.status === 403) throw new HostingError('HOSTING_TOKEN_INVALID');
    if (response.status === 404) throw new HostingError('HOSTING_SITE_NOT_FOUND');
    if (response.status === 409) throw new HostingError('HOSTING_SITE_NAME_TAKEN');
    if (response.status === 429) throw new HostingError('HOSTING_RATE_LIMITED');
    if (!response.ok) throw new HostingError('HOSTING_FAILED');
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async team() {
    if (this.teamId === undefined) {
      const { user } = await this.call<{ user?: { username?: string; name?: string; email?: string; defaultTeamId?: string | null } }>('GET', '/v2/user');
      this.teamId = user?.defaultTeamId ?? null;
      return user;
    }
    return null;
  }

  async verify() {
    const user = await this.team();
    return { account: user?.name || user?.username || user?.email || 'Vercel' };
  }

  private view(project: { id: string; name: string }): HostedSite {
    return { siteId: project.id, url: `https://${project.name}.vercel.app`, adminUrl: 'https://vercel.com/dashboard' };
  }

  async site(siteId: string | null, name: string): Promise<HostedSite> {
    await this.team();
    type Project = { id: string; name: string };
    if (siteId) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(siteId)) throw new HostingError('HOSTING_SITE_NOT_FOUND');
      return this.view(await this.call<Project>('GET', `/v9/projects/${encodeURIComponent(siteId)}`));
    }
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    // No framework and no build: the accepted pages are published as they are.
    return this.view(await this.call<Project>('POST', '/v11/projects', { name: `${slug || 'site'}-${Math.random().toString(36).slice(2, 8)}`, framework: null }));
  }

  async deploy(siteId: string, files: HostingFile[]): Promise<HostingDeploy> {
    await this.team();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(siteId)) throw new HostingError('HOSTING_SITE_NOT_FOUND');
    const project = await this.call<{ id: string; name: string }>('GET', `/v9/projects/${encodeURIComponent(siteId)}`);
    const created = await this.call<{ id: string; url?: string; readyState?: string }>('POST', '/v13/deployments', {
      name: project.name, project: project.id, target: 'production',
      files: files.map((file) => ({ file: file.path.replace(/^\/+/, ''), data: file.content, encoding: 'utf-8' })),
      projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
    });
    return { deployId: created.id, url: `https://${project.name}.vercel.app`, state: (created.readyState ?? 'queued').toLowerCase() };
  }
}

export function hostingProvider(key: string, token: string, fetchImpl?: Fetch): HostingProvider {
  if (key === 'netlify') return new NetlifyProvider(token, fetchImpl);
  if (key === 'vercel') return new VercelProvider(token, fetchImpl);
  throw new HostingError('HOSTING_PROVIDER_UNKNOWN');
}
