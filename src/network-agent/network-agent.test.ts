import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { agentAppOrigin, agentState, bearerKey, hashAgentKey, newAgentKey, readHello, readResult, safeRepoPath } from './network-agent.js';
import { PrismaService } from '../database/prisma.service.js';
import { BillingService } from '../billing/billing.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { ProjectsService } from '../projects/projects.service.js';
import { filesDigestOf } from '../agent/agent-tasks.js';
import { NetworkAgentService } from './network-agent.service.js';
// The program the owner runs; tested here as it is shipped.
// @ts-expect-error — a plain JavaScript module without types
import * as program from '../../apps/network-agent/buildpath-agent.mjs';

describe('network agent rules', () => {
  it('makes keys that are shown once and kept only as a hash', () => {
    const key = newAgentKey();
    assert.match(key.token, /^bpa_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.hash, hashAgentKey(key.token));
    assert.equal(key.hint, key.token.slice(-4));
    assert.equal(bearerKey(`Bearer ${key.token}`), key.token);
    assert.equal(bearerKey(key.token), null);
    assert.equal(bearerKey('Bearer bpa_short'), null);
  });

  it('keeps only what it shows from the agent, and reads results strictly by kind', () => {
    assert.deepEqual(readHello({ version: '1.0.0', capabilities: { check: true, push: 'yes', deploy: true }, appUrl: 'http://app.corp.local:8080/x?y', secret: 'x' }),
      { version: '1.0.0', capabilities: { check: true, push: false, deploy: true, shareOutput: false }, appUrl: 'http://app.corp.local:8080' });
    assert.equal(agentAppOrigin('https://user:pass@app.corp'), null);
    assert.equal(agentAppOrigin('ftp://app.corp'), null);
    assert.deepEqual(readResult('check', { ok: true, status: 200, database: 'postgres', ms: 120, extra: 1 }), { kind: 'check', ok: true, status: 200, database: 'postgres', ms: 120, error: null });
    assert.deepEqual(readResult('push', { ok: true, branch: 'buildpath/agent-1234; rm -rf /', commit: 'abc1234' }), { kind: 'push', ok: true, branch: null, commit: 'abc1234', error: null });
    assert.equal(readResult('deploy', { ok: false, error: 'not a code', exitCode: 1 }).error, 'AGENT_REPORTED_FAILURE');
    assert.equal(readResult('deploy', { ok: true, output: 'x'.repeat(10_000) }).kind === 'deploy' && (readResult('deploy', { ok: true, output: 'x'.repeat(10_000) }) as { output: string }).output.length, 4000);
  });

  it('writes only inside the project', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', '.git/config', 'a/.GIT/hooks/x', 'a\\b', '', 'a//b']) assert.equal(safeRepoPath(bad), false, bad);
    for (const good of ['package.json', 'src/app.ts', '.github/workflows/ci.yml', '.env.example']) assert.equal(safeRepoPath(good), true, good);
  });

  it('tells waiting, online, offline, expired and revoked apart', () => {
    const now = Date.now();
    const base = { lastSeenAt: null, revokedAt: null, expiresAt: new Date(now + 1000) };
    assert.equal(agentState(base, now), 'waiting');
    assert.equal(agentState({ ...base, lastSeenAt: new Date(now - 10_000) }, now), 'online');
    assert.equal(agentState({ ...base, lastSeenAt: new Date(now - 600_000) }, now), 'offline');
    assert.equal(agentState({ ...base, expiresAt: new Date(now - 1) }, now), 'expired');
    assert.equal(agentState({ ...base, revokedAt: new Date() }, now), 'revoked');
  });
});

describe('the agent program', () => {
  it('refuses settings that would leak the key or reach the wrong place', () => {
    assert.ok(program.readConfig({ BUILDPATH_URL: 'http://api.example.com/api/v1', BUILDPATH_AGENT_TOKEN: newAgentKey().token }).problems.some((text: string) => text.includes('https')));
    assert.ok(program.readConfig({ BUILDPATH_URL: 'https://api.example.com/api/v1', BUILDPATH_AGENT_TOKEN: 'x' }).problems.length === 1);
    const config = program.readConfig({ BUILDPATH_URL: 'https://api.example.com/api/v1/', BUILDPATH_AGENT_TOKEN: newAgentKey().token, APP_URL: 'http://app.corp:8080/path', GIT_REMOTE: '/srv/repo.git' });
    assert.deepEqual(config.problems, []);
    assert.equal(config.api, 'https://api.example.com/api/v1');
    assert.equal(config.appUrl, 'http://app.corp:8080');
  });

  it('reads its settings file literally: a deploy command keeps its spaces and quotes', () => {
    const settings = program.parseSettings('# comment\nBUILDPATH_URL=https://a.example/api/v1\r\nDEPLOY_COMMAND=ssh deploy@app ./deploy.sh "$BUILDPATH_BRANCH"\nPATH=/evil\nbroken line\n');
    assert.deepEqual(settings, { BUILDPATH_URL: 'https://a.example/api/v1', DEPLOY_COMMAND: 'ssh deploy@app ./deploy.sh "$BUILDPATH_BRANCH"' });
  });

  it('pushes the files to its own branch of the internal repository and removes what the change deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-agent-test-'));
    try {
      const remote = join(dir, 'remote.git');
      execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
      // The repository already has a main branch with a file the change removes and one it keeps.
      const seed = join(dir, 'seed');
      execFileSync('git', ['clone', '--quiet', remote, seed]);
      execFileSync('sh', ['-c', 'mkdir -p old && echo a > old/gone.txt && echo b > keep.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin HEAD:main'], { cwd: seed });
      const config = program.readConfig({ BUILDPATH_URL: 'https://api.example.com/api/v1', BUILDPATH_AGENT_TOKEN: newAgentKey().token, GIT_REMOTE: remote, WORK_DIR: dir });
      const job = { id: randomUUID(), kind: 'push', payload: { branch: 'buildpath/agent-12345678', message: 'BuildPath: test', removed: ['old/gone.txt', '../escape'] } };
      const call = async (method: string, path: string) => { assert.equal(`${method} ${path}`, `GET /network-agent/jobs/${job.id}/files`); return { files: [{ path: 'package.json', content: '{}' }, { path: 'src/app.js', content: 'ok' }] }; };
      const result = await program.runJob(config, job, call);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.branch, 'buildpath/agent-12345678');
      const tree = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'buildpath/agent-12345678'], { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(tree.sort(), ['keep.txt', 'package.json', 'src/app.js']);
      assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'buildpath/agent-12345678'], { encoding: 'utf8' }).trim(), result.commit);
      // A path outside the project is refused before anything is written.
      const bad = await program.runJob(config, job, async () => ({ files: [{ path: '../x', content: '' }] }));
      assert.deepEqual(bad, { ok: false, error: 'UNSAFE_PATH' });
      // A branch that is not BuildPath's is refused too.
      assert.equal((await program.runJob(config, { ...job, payload: { branch: 'main' } }, call)).error, 'BRANCH_INVALID');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs the owner\'s deploy command and shares its output only when allowed, never with the key', async () => {
    const token = newAgentKey().token;
    const quiet = program.readConfig({ BUILDPATH_URL: 'https://a.example/api/v1', BUILDPATH_AGENT_TOKEN: token, DEPLOY_COMMAND: 'echo "deploying $BUILDPATH_BRANCH"; exit 3' });
    assert.deepEqual(await program.runJob(quiet, { id: 'x', kind: 'deploy', payload: { branch: 'buildpath/agent-1' } }, null), { ok: false, exitCode: 3, output: null, error: 'DEPLOY_FAILED' });
    const shared = program.readConfig({ BUILDPATH_URL: 'https://a.example/api/v1', BUILDPATH_AGENT_TOKEN: token, DEPLOY_COMMAND: `echo "branch $BUILDPATH_BRANCH key ${token}"`, SHARE_DEPLOY_OUTPUT: '1' });
    const result = await program.runJob(shared, { id: 'x', kind: 'deploy', payload: { branch: 'buildpath/agent-1' } }, null);
    assert.equal(result.ok, true);
    assert.equal(result.output.trim(), 'branch buildpath/agent-1 key ***');
  });

  it('checks the application\'s health answer', async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', database: 'postgres' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const config = program.readConfig({ BUILDPATH_URL: 'https://a.example/api/v1', BUILDPATH_AGENT_TOKEN: newAgentKey().token, APP_URL: `http://127.0.0.1:${port}` });
      const result = await program.runJob(config, { id: 'x', kind: 'check', payload: {} }, null);
      assert.equal(result.ok, true);
      assert.equal(result.database, 'postgres');
    } finally { server.close(); }
  });
});

let prisma: PrismaService | null = null;
try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1`; } catch { prisma = null; }
const skip = prisma ? false : 'DATABASE_URL is not reachable';

describe('network agent (database)', () => {
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('connects an agent, gives it jobs once, takes results and stops a revoked key', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    const service = new NetworkAgentService(prisma!, core);
    const email = `agent-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projects = new ProjectsService(prisma!, billing);
    const projectId = (await projects.create(owner.id, { workspaceId: workspace.id, name: 'Внутренний учёт', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const siteId = (await projects.create(owner.id, { workspaceId: workspace.id, name: 'Сайт', startMode: 'build', locale: 'ru', projectType: 'landing' } as never)).data.id;
    await assert.rejects(service.view(owner.id, siteId), /NETWORK_AGENT_NOT_AVAILABLE/);

    assert.equal((await service.view(owner.id, projectId)).data.agent, null);
    const created = (await service.create(owner.id, projectId, { name: 'Офисный сервер' })).data;
    const auth = `Bearer ${created.token}`;
    assert.equal(created.agent!.state, 'waiting');
    // The key itself is never stored.
    assert.equal(await prisma!.networkAgent.count({ where: { projectId, tokenHash: created.token } }), 0);
    await assert.rejects(service.hello('Bearer bpa_' + 'x'.repeat(43), '127.0.0.1', {}), /NETWORK_AGENT_KEY_INVALID/);

    await service.hello(auth, '127.0.0.1', { version: '1.0.0', capabilities: { check: true, push: true, deploy: false }, appUrl: 'http://app.corp.local:8080' });
    const seen = (await service.view(owner.id, projectId)).data.agent!;
    assert.equal(seen.state, 'online');
    assert.equal(seen.appUrl, 'http://app.corp.local:8080');
    // Deploy was not set up on the agent's side: refused here. Push and deploy need a confirmation.
    await assert.rejects(service.startJob(owner.id, projectId, { kind: 'deploy', confirm: true }), /NETWORK_AGENT_CANNOT_DO/);
    await assert.rejects(service.startJob(owner.id, projectId, { kind: 'push' }), /CONFIRMATION_REQUIRED/);
    await assert.rejects(service.startJob(owner.id, projectId, { kind: 'shell' }), /NETWORK_AGENT_JOB_KIND_INVALID/);

    // A check: taken once, its result becomes the application's deployment check from inside the network.
    await service.startJob(owner.id, projectId, { kind: 'check' });
    await assert.rejects(service.startJob(owner.id, projectId, { kind: 'check' }), /NETWORK_AGENT_JOB_WAITING/);
    const [first, second] = await Promise.all([service.next(auth, '127.0.0.1', 0), service.next(auth, '127.0.0.1', 0)]);
    assert.equal([first.job, second.job].filter(Boolean).length, 1);
    const job = (first.job ?? second.job)!;
    assert.equal(job.kind, 'check');
    await service.result(auth, '127.0.0.1', job.id, { ok: true, status: 200, database: 'postgres', ms: 40 });
    await assert.rejects(service.result(auth, '127.0.0.1', job.id, { ok: true }), /NETWORK_AGENT_JOB_NOT_RUNNING/);
    const deployment = await prisma!.appDeployment.findUniqueOrThrow({ where: { projectId } });
    assert.deepEqual({ url: deployment.url, ok: deployment.ok, database: deployment.database, via: deployment.checkedVia }, { url: 'http://app.corp.local:8080', ok: true, database: 'postgres', via: 'network_agent' });

    // A push sends the agent task's code; the agent gets the files only while the job is its own and running.
    const files = [{ path: 'package.json', content: '{}' }, { path: '../evil', content: 'x' }];
    const task = await prisma!.agentTask.create({ data: { projectId, kind: 'build_app', status: 'succeeded', profile: 'p', locale: 'ru', sourceVersionId: randomUUID(), inputVersionIds: [], prompt: {}, promptDigest: 'd', limits: {}, files: files as never, filesDigest: filesDigestOf(files), requestedByUserId: owner.id } });
    assert.equal((await service.view(owner.id, projectId)).data.pushTask!.id, task.id);
    await service.startJob(owner.id, projectId, { kind: 'push', confirm: true, taskId: task.id });
    const push = (await service.next(auth, '127.0.0.1', 0)).job!;
    assert.equal((push.payload as { branch: string }).branch, `buildpath/agent-${task.id.slice(0, 8)}`);
    assert.deepEqual((await service.files(auth, '127.0.0.1', push.id)).files.map((file) => file.path), ['package.json']);
    await service.result(auth, '127.0.0.1', push.id, { ok: false, error: 'GIT_PUSH_FAILED' });
    const jobs = (await service.view(owner.id, projectId)).data.jobs;
    assert.equal(jobs.find((item) => item.id === push.id)!.status, 'failed');
    assert.equal(jobs.find((item) => item.id === push.id)!.error, 'GIT_PUSH_FAILED');
    const events = await prisma!.projectEvent.findMany({ where: { projectId, type: { startsWith: 'network_agent_' } }, select: { type: true } });
    assert.ok(['network_agent_created', 'network_agent_connected', 'network_agent_job_started', 'network_agent_job_done'].every((type) => events.some((event) => event.type === type)));

    // A new key replaces the old one; the old key is refused at once.
    const replaced = (await service.create(owner.id, projectId, {})).data;
    await assert.rejects(service.next(auth, '127.0.0.1', 0), /NETWORK_AGENT_KEY_REVOKED/);
    await service.revoke(owner.id, projectId);
    await assert.rejects(service.hello(`Bearer ${replaced.token}`, '127.0.0.1', {}), /NETWORK_AGENT_KEY_REVOKED/);
    assert.equal((await service.view(owner.id, projectId)).data.agent, null);
  });
});
