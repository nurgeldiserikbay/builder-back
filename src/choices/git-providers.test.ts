import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubClient, GitLabClient, GitProviderError, parseRepoUrl } from './git-providers.js';
import { choiceCards, recommend } from './cards.js';

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
function fakeFetch(routes: Array<[method: string, pattern: RegExp, status: number, payload: unknown]>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url));
    if (!route) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(route[3]), { status: route[2] });
  }) as typeof fetch;
  return { impl, calls };
}

describe('repository address', () => {
  it('accepts addresses copied from the browser', () => {
    assert.deepEqual(parseRepoUrl('github', 'https://github.com/aigerim/my-site.git', false), { baseUrl: 'https://github.com', repoPath: 'aigerim/my-site' });
    assert.deepEqual(parseRepoUrl('github', 'https://github.com/aigerim/my-site/tree/main', false).repoPath, 'aigerim/my-site');
    assert.deepEqual(parseRepoUrl('gitlab', 'https://gitlab.example.kz/team/web/site/-/tree/main', false), { baseUrl: 'https://gitlab.example.kz', repoPath: 'team/web/site' });
  });
  it('refuses other hosts for GitHub, plain http, credentials and odd paths', () => {
    for (const [provider, url, code] of [
      ['github', 'https://gitlab.com/a/b', 'REPO_URL_NOT_GITHUB'], ['github', 'http://github.com/a/b', 'REPO_URL_INVALID'],
      ['gitlab', 'https://user:pass@gitlab.com/a/b', 'REPO_URL_INVALID'], ['github', 'https://github.com/a', 'REPO_URL_INVALID'],
      ['gitlab', 'https://gitlab.com/a/<b>', 'REPO_URL_INVALID'], ['github', 'http://localhost:9/a/b', 'REPO_URL_INVALID'],
    ] as const) {
      assert.throws(() => parseRepoUrl(provider, url, false), (error: unknown) => error instanceof GitProviderError && error.code === code, url);
    }
    assert.equal(parseRepoUrl('github', 'http://localhost:9/a/b', true).baseUrl, 'http://localhost:9');
  });
});

describe('GitHub client', () => {
  it('reports write access from repository permissions', async () => {
    const { impl, calls } = fakeFetch([['GET', /\/repos\/a\/b$/, 200, { full_name: 'a/b', html_url: 'https://github.com/a/b', default_branch: 'main', private: true, permissions: { push: true } }]]);
    const info = await new GitHubClient('token-123', 'https://api.test', impl).inspect('a/b');
    assert.deepEqual(info, { repoPath: 'a/b', webUrl: 'https://github.com/a/b', defaultBranch: 'main', isPrivate: true, canWrite: true });
    assert.equal(calls[0].headers.Authorization, 'Bearer token-123');
    const readOnly = fakeFetch([['GET', /\/repos\/a\/b$/, 200, { permissions: { pull: true } }]]);
    assert.equal((await new GitHubClient('t', 'https://api.test', readOnly.impl).inspect('a/b')).canWrite, false);
  });
  it('maps provider answers to safe codes', async () => {
    for (const [status, code] of [[401, 'REPO_TOKEN_INVALID'], [403, 'REPO_ACCESS_DENIED'], [404, 'REPO_NOT_FOUND'], [500, 'REPO_PROVIDER_FAILED']] as const) {
      const { impl } = fakeFetch([['GET', /\/repos\//, status, { message: 'Bad credentials token-123' }]]);
      await assert.rejects(new GitHubClient('token-123', 'https://api.test', impl).inspect('a/b'), (error: unknown) => error instanceof GitProviderError && error.code === code && !error.message.includes('token'));
    }
  });
  it('commits all files at once on an existing branch', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /git\/ref\/heads\/main$/, 200, { object: { sha: 'p1' } }],
      ['GET', /git\/commits\/p1$/, 200, { tree: { sha: 't1' } }],
      ['POST', /git\/trees$/, 201, { sha: 't2' }],
      ['POST', /git\/commits$/, 201, { sha: 'c2', html_url: 'https://github.com/a/b/commit/c2' }],
      ['PATCH', /git\/refs\/heads\/main$/, 200, {}],
    ]);
    const result = await new GitHubClient('t', 'https://api.test', impl).commit('a/b', 'main', [{ path: 'index.html', content: '<h1>Hi</h1>' }, { path: 'README.md', content: '#' }], 'msg');
    assert.equal(result.commitUrl, 'https://github.com/a/b/commit/c2');
    assert.deepEqual((calls[2].body as { tree: Array<{ path: string }> }).tree.map((item) => item.path), ['index.html', 'README.md']);
    assert.deepEqual(calls[3].body, { message: 'msg', tree: 't2', parents: ['p1'] });
    assert.deepEqual(calls[4].body, { sha: 'c2', force: false });
  });
  it('creates the first commit in an empty repository', async () => {
    let refCalls = 0;
    const base = fakeFetch([
      ['PUT', /contents\/index\.html$/, 201, { commit: { html_url: 'https://github.com/a/b/commit/c1' } }],
      ['GET', /git\/commits\/c1$/, 200, { tree: { sha: 't1' } }],
      ['POST', /git\/trees$/, 201, { sha: 't2' }],
      ['POST', /git\/commits$/, 201, { sha: 'c2', html_url: 'https://github.com/a/b/commit/c2' }],
      ['PATCH', /git\/refs\/heads\/main$/, 200, {}],
    ]);
    const impl = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('git/ref/heads/main')) return new Response(JSON.stringify(refCalls++ ? { object: { sha: 'c1' } } : { message: 'Git Repository is empty.' }), { status: refCalls === 1 ? 409 : 200 });
      return base.impl(input, init);
    }) as typeof fetch;
    const result = await new GitHubClient('t', 'https://api.test', impl).commit('a/b', 'main', [{ path: 'index.html', content: 'x' }, { path: 'README.md', content: 'y' }], 'msg');
    assert.equal(result.commitUrl, 'https://github.com/a/b/commit/c2');
    const put = base.calls.find((call) => call.method === 'PUT')!;
    assert.equal((put.body as { content: string }).content, Buffer.from('x').toString('base64'));
  });
});

describe('GitLab client', () => {
  it('needs Developer access to write and creates or updates files in one commit', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /projects\/team%2Fsite$/, 200, { path_with_namespace: 'team/site', web_url: 'https://gl.kz/team/site', default_branch: 'main', visibility: 'private', permissions: { project_access: { access_level: 30 } } }],
      ['GET', /files\/index\.html\?ref=main$/, 200, {}],
      ['GET', /files\/README\.md\?ref=main$/, 404, {}],
      ['POST', /repository\/commits$/, 201, { web_url: 'https://gl.kz/team/site/-/commit/abc' }],
    ]);
    const client = new GitLabClient('glpat-token', 'https://gl.kz', impl);
    assert.equal((await client.inspect('team/site')).canWrite, true);
    assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'glpat-token');
    const result = await client.commit('team/site', 'main', [{ path: 'index.html', content: 'x' }, { path: 'README.md', content: 'y' }], 'msg');
    assert.equal(result.commitUrl, 'https://gl.kz/team/site/-/commit/abc');
    assert.deepEqual((calls.at(-1)!.body as { actions: Array<{ action: string }> }).actions.map((item) => item.action), ['update', 'create']);
    const reporter = fakeFetch([['GET', /projects\//, 200, { permissions: { project_access: { access_level: 20 } } }]]);
    assert.equal((await new GitLabClient('t', 'https://gl.kz', reporter.impl).inspect('a/b')).canWrite, false);
  });
});

describe('code hosting card', () => {
  it('explains every option and recommends by project', () => {
    for (const option of choiceCards.code_hosting.options) {
      assert.ok(option.pros.length && option.limits.length && option.cost && option.leaving && option.steps.length, option.key);
    }
    assert.equal(recommend('code_hosting', { hasSpecialists: false }).optionKey, 'archive');
    assert.equal(recommend('code_hosting', { hasSpecialists: true }).optionKey, 'github');
  });
});
