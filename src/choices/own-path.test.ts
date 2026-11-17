// «Свой путь»: Gitea/Forgejo and Bitbucket repositories, Vercel hosting and files for the owner's own infrastructure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BitbucketClient, GiteaClient, GitHubClient, GitLabClient, GitProviderError, parseRepoUrl } from './git-providers.js';
import { HostingError, VercelProvider } from './hosting-providers.js';
import { CI_MARKER, ciDeployFile, ciFilePath, renderBlueprint, staticDockerfile } from './infra-files.js';
import { choiceCards } from './cards.js';

type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };
type Route = [method: string, pattern: RegExp, status: number, payload: unknown, headers?: Record<string, string>];
function fakeFetch(routes: Route[]) {
  const calls: Seen[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, headers: init?.headers as Record<string, string> });
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url));
    if (!route) return new Response('{}', { status: 500 });
    const text = typeof route[3] === 'string' ? route[3] : JSON.stringify(route[3]);
    return new Response(route[2] === 204 ? null : text, { status: route[2], headers: route[4] });
  }) as typeof fetch;
  return { impl, calls };
}
const isCode = (code: string) => (error: unknown) => (error instanceof GitProviderError || error instanceof HostingError) && error.code === code;
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('own path: repository addresses', () => {
  it('reads Gitea, Forgejo and Codeberg addresses on any server and Bitbucket only on bitbucket.org', () => {
    assert.deepEqual(parseRepoUrl('gitea', 'https://codeberg.org/aigerim/my-site/src/branch/main', false), { baseUrl: 'https://codeberg.org', repoPath: 'aigerim/my-site' });
    assert.deepEqual(parseRepoUrl('gitea', 'https://git.company.kz/web/site.git', false), { baseUrl: 'https://git.company.kz', repoPath: 'web/site' });
    assert.deepEqual(parseRepoUrl('bitbucket', 'https://bitbucket.org/team/my-site/src/main/', false), { baseUrl: 'https://bitbucket.org', repoPath: 'team/my-site' });
    assert.throws(() => parseRepoUrl('bitbucket', 'https://github.com/a/b', false), isCode('REPO_URL_NOT_BITBUCKET'));
    assert.throws(() => parseRepoUrl('gitea', 'http://git.company.kz/a/b', false), isCode('REPO_URL_INVALID'));
    assert.throws(() => parseRepoUrl('gitea', 'https://git.company.kz/a', false), isCode('REPO_URL_INVALID'));
  });
});

describe('own path: Gitea and Forgejo', () => {
  it('reads write access and commits every file in one change, updating existing files by their hash', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /\/api\/v1\/repos\/a\/b$/, 200, { full_name: 'a/b', html_url: 'https://codeberg.org/a/b', default_branch: 'main', private: true, permissions: { push: true } }],
      ['GET', /\/contents\/index\.html\?ref=main$/, 200, { sha: 'old-sha', content: b64('<html>') }],
      ['GET', /\/contents\//, 404, {}],
      ['POST', /\/api\/v1\/repos\/a\/b\/contents$/, 201, { commit: { html_url: 'https://codeberg.org/a/b/commit/abc' } }],
    ]);
    const client = new GiteaClient('gitea-token-1', 'https://codeberg.org', impl);
    assert.deepEqual(await client.inspect('a/b'), { repoPath: 'a/b', webUrl: 'https://codeberg.org/a/b', defaultBranch: 'main', isPrivate: true, canWrite: true });
    assert.equal(calls[0].headers.Authorization, 'token gitea-token-1');
    const result = await client.commit('a/b', 'main', [{ path: 'index.html', content: '<html>new' }, { path: '.gitea/workflows/x.yml', content: 'x', marker: CI_MARKER }], 'msg');
    assert.equal(result.commitUrl, 'https://codeberg.org/a/b/commit/abc');
    const body = calls.at(-1)!.body as { branch: string; files: Array<{ operation: string; path: string; sha?: string; content: string }> };
    assert.equal(body.branch, 'main');
    assert.deepEqual(body.files.map((file) => [file.operation, file.path, file.sha]), [['update', 'index.html', 'old-sha'], ['create', '.gitea/workflows/x.yml', undefined]]);
    assert.equal(Buffer.from(body.files[0].content, 'base64').toString(), '<html>new');
  });
  it('says plainly when the server is too old for several files in one commit', async () => {
    const { impl } = fakeFetch([['GET', /\/contents\//, 404, {}], ['POST', /\/contents$/, 405, {}]]);
    await assert.rejects(new GiteaClient('t', 'https://git.old.kz', impl).commit('a/b', 'main', [{ path: 'index.html', content: 'x' }], 'm'), isCode('REPO_SERVER_TOO_OLD'));
  });
});

describe('own path: Bitbucket', () => {
  it('accepts a token that reads the repository and commits through the form endpoint', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /\/repositories\/team\/site$/, 200, { full_name: 'team/site', links: { html: { href: 'https://bitbucket.org/team/site' } }, mainbranch: null, is_private: true }],
      ['POST', /\/repositories\/team\/site\/src$/, 201, '', { location: 'https://api.bitbucket.org/2.0/repositories/team/site/commit/0123abcd' }],
    ]);
    const client = new BitbucketClient('bb-token', 'https://api.bitbucket.org/2.0', impl);
    const info = await client.inspect('team/site');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(info.canWrite, true);
    const { commitUrl } = await client.commit('team/site', 'main', [{ path: 'index.html', content: '<html>' }, { path: 'about.html', content: '<p>' }], 'msg');
    assert.equal(commitUrl, 'https://bitbucket.org/team/site/commits/0123abcd');
    const form = calls.at(-1)!.body as FormData;
    assert.equal(form.get('branch'), 'main');
    assert.equal(await (form.get('index.html') as Blob).text(), '<html>');
    assert.equal(calls.at(-1)!.headers.Authorization, 'Bearer bb-token');
  });
  it('turns a refused write into a clear code', async () => {
    const { impl } = fakeFetch([['POST', /\/src$/, 403, {}]]);
    await assert.rejects(new BitbucketClient('t', 'https://api.test', impl).commit('a/b', 'main', [{ path: 'index.html', content: 'x' }], 'm'), isCode('REPO_WRITE_NOT_ALLOWED'));
  });
});

describe('own path: never overwriting the owner\'s own pipeline', () => {
  it('refuses to replace a .gitlab-ci.yml or bitbucket-pipelines.yml written by someone else, and updates its own', async () => {
    const theirs = fakeFetch([['GET', /\/repository\/files\/\.gitlab-ci\.yml/, 200, { content: b64('test:\n  script: npm test\n') }]]);
    await assert.rejects(new GitLabClient('t', 'https://gitlab.com', theirs.impl).commit('a/b', 'main', [ciDeployFile('gitlab', 'main')], 'm'), isCode('REPO_CI_FILE_EXISTS'));
    const ours = fakeFetch([
      ['GET', /\/repository\/files\/\.gitlab-ci\.yml/, 200, { content: b64(ciDeployFile('gitlab', 'main').content) }],
      ['POST', /\/repository\/commits$/, 201, { web_url: 'https://gitlab.com/a/b/-/commit/1' }],
    ]);
    await new GitLabClient('t', 'https://gitlab.com', ours.impl).commit('a/b', 'main', [ciDeployFile('gitlab', 'main')], 'm');
    const bitbucket = fakeFetch([['GET', /\/src\/main\/bitbucket-pipelines\.yml$/, 200, 'pipelines:\n  default: []\n']]);
    await assert.rejects(new BitbucketClient('t', 'https://api.test', bitbucket.impl).commit('a/b', 'main', [ciDeployFile('bitbucket', 'main')], 'm'), isCode('REPO_CI_FILE_EXISTS'));
  });
  it('explains a GitHub key without the workflow permission', async () => {
    const { impl } = fakeFetch([
      ['GET', /\/contents\//, 404, {}],
      ['GET', /\/git\/ref\/heads\/main$/, 200, { object: { sha: 'p' } }],
      ['GET', /\/git\/commits\/p$/, 200, { tree: { sha: 't' } }],
      ['POST', /\/git\/trees$/, 404, { message: 'refusing to allow a Personal Access Token to create or update workflow' }],
    ]);
    await assert.rejects(new GitHubClient('t', 'https://api.test', impl).commit('a/b', 'main', [ciDeployFile('github', 'main')], 'm'), isCode('REPO_WORKFLOW_PERMISSION'));
  });
});

describe('own path: files for own infrastructure', () => {
  it('writes a deploy pipeline per service that copies only the pages and keeps secrets in the repository', () => {
    for (const provider of ['github', 'gitlab', 'gitea', 'bitbucket'] as const) {
      const file = ciDeployFile(provider, 'main');
      assert.equal(file.path, ciFilePath[provider]);
      assert.equal(file.marker, CI_MARKER);
      assert.ok(file.content.includes(CI_MARKER));
      assert.ok(file.content.includes("--include='*.html' --exclude='*'"), provider);
      assert.ok(file.content.includes('StrictHostKeyChecking=yes'), provider);
      for (const secret of ['SSH_HOST', 'SSH_USER', 'SSH_PRIVATE_KEY', 'SSH_KNOWN_HOSTS']) assert.ok(file.content.includes(secret), `${provider} ${secret}`);
    }
    assert.ok(ciDeployFile('github', 'release').content.includes('branches: ["release"]'));
    assert.ok(ciDeployFile('gitlab', 'bad branch; rm -rf /').content.includes('== "main"'));
  });
  it('describes the site for Render and as a container image', () => {
    const blueprint = renderBlueprint('Кондитерская Тая');
    assert.equal(blueprint.path, 'render.yaml');
    assert.match(blueprint.content, /runtime: static/);
    assert.match(blueprint.content, /staticPublishPath: \.\/public/);
    assert.match(staticDockerfile(), /^FROM caddy:2-alpine$/m);
  });
  it('offers the new places and services with what each needs', () => {
    assert.deepEqual(choiceCards.code_hosting.options.map((option) => option.key), ['archive', 'github', 'gitlab', 'gitea', 'bitbucket']);
    assert.deepEqual(choiceCards.deployment.options.map((option) => option.key), ['buildpath', 'github_pages', 'netlify', 'vercel', 'render', 'own_server']);
    assert.deepEqual(choiceCards.deployment.options.find((option) => option.key === 'render')!.requires!.option, ['github', 'gitlab', 'bitbucket']);
  });
});

describe('own path: Vercel', () => {
  it('uses the default team, creates a project without a build and deploys the page to production', async () => {
    const { impl, calls } = fakeFetch([
      ['GET', /\/v2\/user$/, 200, { user: { name: 'Айгерим', defaultTeamId: 'team_1' } }],
      ['POST', /\/v11\/projects\?teamId=team_1$/, 200, { id: 'prj_1', name: 'cakes-ab12cd' }],
      ['GET', /\/v9\/projects\/prj_1\?teamId=team_1$/, 200, { id: 'prj_1', name: 'cakes-ab12cd' }],
      ['POST', /\/v13\/deployments\?teamId=team_1$/, 200, { id: 'dpl_1', readyState: 'QUEUED' }],
    ]);
    const vercel = new VercelProvider('vc-token', impl, 'https://api.test');
    assert.deepEqual(await vercel.verify(), { account: 'Айгерим' });
    const site = await vercel.site(null, 'Cakes');
    assert.equal(site.url, 'https://cakes-ab12cd.vercel.app');
    const deployed = await vercel.deploy(site.siteId, [{ path: 'index.html', content: '<html>' }]);
    assert.deepEqual(deployed, { deployId: 'dpl_1', url: 'https://cakes-ab12cd.vercel.app', state: 'queued' });
    const body = calls.at(-1)!.body as { target: string; files: Array<{ file: string; data: string }>; projectSettings: { framework: null } };
    assert.equal(body.target, 'production');
    assert.deepEqual(body.files, [{ file: 'index.html', data: '<html>', encoding: 'utf-8' }]);
    assert.equal(body.projectSettings.framework, null);
  });
  it('maps refusals to safe codes', async () => {
    const { impl } = fakeFetch([['GET', /\/v2\/user/, 403, {}]]);
    await assert.rejects(new VercelProvider('t', impl, 'https://api.test').verify(), isCode('HOSTING_TOKEN_INVALID'));
  });
});
