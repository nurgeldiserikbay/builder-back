import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitProviderError } from './git-providers.js';
import { authorizeUrl, createRepo, exchangeCode, githubOauthConfig, validRepoName, writableRepos } from './github-oauth.js';

const config = githubOauthConfig({ GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret', PUBLIC_API_URL: 'https://api.buildpath.kz/' })!;
const reply = (status: number, payload: unknown) => (async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('GitHub OAuth', () => {
  it('is off until the app credentials and the public API address are set', () => {
    assert.equal(githubOauthConfig({ GITHUB_OAUTH_CLIENT_ID: 'id' }), null);
    assert.equal(config.redirectUrl, 'https://api.buildpath.kz/api/v1/oauth/github/callback');
  });

  it('asks only for repository access, with the state', () => {
    const url = new URL(authorizeUrl(config, 'state123'));
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('scope'), 'repo');
    assert.equal(url.searchParams.get('state'), 'state123');
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUrl);
  });

  it('turns a rejected code into a safe error', async () => {
    assert.equal(await exchangeCode(config, 'c', reply(200, { access_token: 'gho_x' })), 'gho_x');
    await assert.rejects(exchangeCode(config, 'c', reply(200, { error: 'bad_verification_code' })), (error: GitProviderError) => error.code === 'GITHUB_OAUTH_FAILED');
  });

  it('lists only repositories the person can write to', async () => {
    const repos = await writableRepos(config, 't', reply(200, [
      { full_name: 'a/site', html_url: 'u', private: true, permissions: { push: true } },
      { full_name: 'b/read', html_url: 'u', permissions: { pull: true } },
      { full_name: 'a/old', html_url: 'u', archived: true, permissions: { admin: true } },
    ]));
    assert.deepEqual(repos.map((repo) => repo.fullName), ['a/site']);
    await assert.rejects(writableRepos(config, 't', reply(401, {})), (error: GitProviderError) => error.code === 'GITHUB_RECONNECT_REQUIRED');
  });

  it('validates new repository names and reports a taken name', async () => {
    assert.equal(validRepoName('barber-site'), true);
    for (const name of ['', '..', 'a b', 'x.git', 'a/b']) assert.equal(validRepoName(name), false, name);
    await assert.rejects(createRepo(config, 't', { name: 'site', isPrivate: true, description: '' }, reply(422, {})), (error: GitProviderError) => error.code === 'REPO_NAME_TAKEN');
  });
});
