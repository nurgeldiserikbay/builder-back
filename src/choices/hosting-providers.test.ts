import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { HostingError, NetlifyProvider, hostingProvider } from './hosting-providers.js';

/** A tiny Netlify API double: records calls, asks for files it does not have. */
function fakeNetlify(options: { token?: string; known?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; body: string | null; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ method: init.method ?? 'GET', path, body, auth: (init.headers as Record<string, string>).authorization ?? null });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${options.token ?? 'good'}`) return json(401, { message: 'unauthorized' });
    if (path === '/user') return json(200, { full_name: 'Айгерим', email: 'a@b.kz' });
    if (path === '/sites' && init.method === 'POST') return json(201, { id: 'site-new', ssl_url: 'https://cakes-x1.netlify.app', admin_url: 'https://app.netlify.com/sites/cakes-x1' });
    if (path === '/sites/site-old') return json(200, { id: 'site-old', ssl_url: 'https://old.netlify.app' });
    if (path === '/sites/missing') return json(404, {});
    if (/^\/sites\/[^/]+\/deploys$/.test(path)) {
      const digests = Object.values((JSON.parse(body ?? '{}') as { files: Record<string, string> }).files);
      return json(200, { id: 'deploy-1', required: digests.filter((digest) => !(options.known ?? []).includes(digest)), ssl_url: 'https://cakes-x1.netlify.app', state: 'uploading' });
    }
    if (path.startsWith('/deploys/deploy-1/files/')) return json(200, {});
    return json(500, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('external hosting: Netlify', () => {
  it('checks the token, creates a site with a free name and deploys only what Netlify asks for', async () => {
    const { calls, fetchImpl } = fakeNetlify();
    const netlify = new NetlifyProvider('good', fetchImpl, 'https://api.test/api/v1');
    assert.deepEqual(await netlify.verify(), { account: 'Айгерим' });
    const site = await netlify.site(null, 'Торты Айгерим & Co');
    assert.equal(site.siteId, 'site-new');
    assert.match(JSON.parse(calls.at(-1)!.body!).name, /^co-[a-z0-9]{6}$|^site-[a-z0-9]{6}$|^[a-z0-9-]+-[a-z0-9]{6}$/);
    const page = '<!doctype html><title>Торты</title>';
    const deployed = await netlify.deploy('site-new', [{ path: 'index.html', content: page }]);
    assert.equal(deployed.deployId, 'deploy-1');
    const sent = JSON.parse(calls.find((call) => call.path === '/sites/site-new/deploys')!.body!).files;
    assert.deepEqual(sent, { '/index.html': createHash('sha1').update(page).digest('hex') });
    const upload = calls.find((call) => call.path === '/deploys/deploy-1/files/index.html')!;
    assert.equal(upload.body, page);
    assert.ok(calls.every((call) => call.auth === 'Bearer good'));
  });

  it('skips files Netlify already has and uses an existing site by its ID', async () => {
    const page = 'same page';
    const { calls, fetchImpl } = fakeNetlify({ known: [createHash('sha1').update(page).digest('hex')] });
    const netlify = new NetlifyProvider('good', fetchImpl, 'https://api.test/api/v1');
    assert.equal((await netlify.site('site-old', 'x')).url, 'https://old.netlify.app');
    await netlify.deploy('site-old', [{ path: 'index.html', content: page }]);
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  });

  it('turns provider answers into clear codes', async () => {
    const { fetchImpl } = fakeNetlify();
    await assert.rejects(new NetlifyProvider('bad', fetchImpl, 'https://api.test/api/v1').verify(), (error: HostingError) => error.code === 'HOSTING_TOKEN_INVALID');
    await assert.rejects(new NetlifyProvider('good', fetchImpl, 'https://api.test/api/v1').site('missing', 'x'), (error: HostingError) => error.code === 'HOSTING_SITE_NOT_FOUND');
    await assert.rejects(new NetlifyProvider('good', fetchImpl, 'https://api.test/api/v1').site('../etc', 'x'), (error: HostingError) => error.code === 'HOSTING_SITE_NOT_FOUND');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await assert.rejects(new NetlifyProvider('good', down, 'https://api.test/api/v1').verify(), (error: HostingError) => error.code === 'HOSTING_UNAVAILABLE');
    assert.throws(() => hostingProvider('vercel', 't'), (error: HostingError) => error.code === 'HOSTING_PROVIDER_UNKNOWN');
  });
});
