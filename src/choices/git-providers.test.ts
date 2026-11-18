import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BitbucketClient, GitHubClient, GiteaClient, GitLabClient, GitProviderError, parseRepoUrl } from './git-providers.js';
import { chooseEntries, REPO_READ_LIMITS, wantedPath } from './repo-read.js';
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

describe('reading the code of a branch back', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  it('keeps source and config, never secrets, build output, packages or binaries, within limits', () => {
    for (const ok of ['package.json', 'src/app.js', '.env.example', 'README.md', 'public/manifest.webmanifest']) assert.equal(wantedPath(ok), true, ok);
    for (const bad of ['.env', '.env.production', 'node_modules/x/index.js', 'dist/index.html', '.git/config', 'keys/id_rsa', 'cert.pem', 'logo.png', 'font.woff2', '../x', '/etc/passwd']) assert.equal(wantedPath(bad), false, bad);
    const many = Array.from({ length: REPO_READ_LIMITS.files + 5 }, (_, n) => ({ path: `src/f${String(n).padStart(4, '0')}.js`, size: 10 }));
    const chosen = chooseEntries([...many, { path: 'big.js', size: REPO_READ_LIMITS.fileBytes + 1 }]);
    assert.equal(chosen.chosen.length, REPO_READ_LIMITS.files);
    assert.equal(chosen.truncated, true);
  });
  it('GitHub: the tree of the branch commit, then blobs; an empty repository is null', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /git\/ref\/heads\/main$/, 200, { object: { sha: 'c9' } }],
      ['GET', /git\/trees\/c9\?recursive=1$/, 200, { tree: [{ path: 'package.json', type: 'blob', size: 20, sha: 's1' }, { path: 'src', type: 'tree', sha: 'x' }, { path: 'src/a.js', type: 'blob', size: 9, sha: 's2' }, { path: '.env', type: 'blob', size: 5, sha: 's3' }, { path: 'logo.png', type: 'blob', size: 5, sha: 's4' }], truncated: false }],
      ['GET', /git\/blobs\/s1$/, 200, { content: b64('{"name":"app"}') }],
      ['GET', /git\/blobs\/s2$/, 200, { content: b64('export {}\n') }],
    ]);
    const snapshot = await new GitHubClient('t', 'https://api.test', impl).readBranch('a/b', 'main');
    assert.deepEqual(snapshot, { files: [{ path: 'package.json', content: '{"name":"app"}' }, { path: 'src/a.js', content: 'export {}\n' }], truncated: false, commit: 'c9', branch: 'main' });
    assert.ok(!calls.some((call) => /s3|s4/.test(call.url)), 'secrets and binaries are not even downloaded');
    const empty = fakeFetch([['GET', /git\/ref\/heads\/main$/, 409, {}]]);
    assert.equal(await new GitHubClient('t', 'https://api.test', empty.impl).readBranch('a/b', 'main'), null);
  });
  it('GitLab, Gitea and Bitbucket read the same way through their own APIs', async () => {
    const gitlab = fakeFetch([
      ['GET', /repository\/branches\/main$/, 200, { commit: { id: 'g1' } }],
      ['GET', /repository\/tree\?ref=g1&recursive=true&per_page=100&page=1$/, 200, [{ path: 'index.js', type: 'blob', id: 'b1' }, { path: 'lib', type: 'tree', id: 'x' }]],
      ['GET', /repository\/blobs\/b1$/, 200, { content: b64('1') }],
    ]);
    assert.deepEqual((await new GitLabClient('t', 'https://gl.test', gitlab.impl).readBranch('team/app', 'main'))!.files, [{ path: 'index.js', content: '1' }]);
    const gitea = fakeFetch([
      ['GET', /repos\/o\/r\/branches\/main$/, 200, { commit: { id: 'e1' } }],
      ['GET', /git\/trees\/e1\?recursive=true/, 200, { tree: [{ path: 'a.js', type: 'blob', size: 1, sha: 'h1' }] }],
      ['GET', /git\/blobs\/h1$/, 200, { content: b64('2') }],
    ]);
    assert.deepEqual((await new GiteaClient('t', 'https://gt.test', gitea.impl).readBranch('o/r', 'main'))!.files, [{ path: 'a.js', content: '2' }]);
    const bitbucket = fakeFetch([
      ['GET', /refs\/branches\/main$/, 200, { target: { hash: 'k1' } }],
      ['GET', /src\/k1\/\?max_depth=30&pagelen=100$/, 200, { values: [{ type: 'commit_file', path: 'a.js', size: 1 }, { type: 'commit_directory', path: 'lib' }], next: 'https://evil.test/steal' }],
      ['GET', /src\/k1\/a\.js$/, 200, '3'],
    ]);
    const snapshot = await new BitbucketClient('t', 'https://bb.test/2.0', bitbucket.impl).readBranch('o/r', 'main');
    assert.deepEqual(snapshot!.files, [{ path: 'a.js', content: '"3"' }]);
    assert.ok(!bitbucket.calls.some((call) => call.url.startsWith('https://evil.test')), 'a «next» link to another host is not followed with the token');
    assert.equal(snapshot!.truncated, true);
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
