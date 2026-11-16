// External static hosting for the accepted site (deployment card). One interface for every provider, so adding Vercel or
// Cloudflare Pages later is one more class here. Each deploy is an explicit owner action with confirmation; BuildPath sends
// only the accepted, self-contained page (images inline), never project data or secrets.
import { createHash } from 'node:crypto';

export type HostingProviderKey = 'netlify';
export const HOSTING_PROVIDERS: HostingProviderKey[] = ['netlify'];

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

export function hostingProvider(key: string, token: string, fetchImpl?: Fetch): HostingProvider {
  if (key === 'netlify') return new NetlifyProvider(token, fetchImpl);
  throw new HostingError('HOSTING_PROVIDER_UNKNOWN');
}
