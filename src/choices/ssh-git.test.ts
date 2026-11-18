import 'dotenv/config';
// Any git over SSH: address parsing always; the real push against a throwaway sshd and bare repository when the machine has
// OpenSSH and runs as root (the API image build has no sshd, so there it is skipped).
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { GitProviderError } from './git-providers.js';
import { generateDeployKey, parseSshUrl, scanHostKeys, sshDisplayUrl, SshGitClient, sshToolsAvailable } from './ssh-git.js';
import { CI_MARKER } from './infra-files.js';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ChangeNoticesService } from '../journey/change-notices.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { JourneyService } from '../journey/journey.service.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { StageReviewService } from '../journey/stage-review.service.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ChoicesService } from './choices.service.js';
import { randomBytes, randomUUID } from 'node:crypto';

const run = promisify(execFile);
const isCode = (code: string) => (error: unknown) => error instanceof GitProviderError && error.code === code;

describe('any git over SSH: addresses', () => {
  it('reads scp-style and ssh:// addresses and keeps relative and absolute paths apart', () => {
    assert.deepEqual(parseSshUrl('git@github.com:aigerim/site.git'), { user: 'git', host: 'github.com', port: 22, path: 'aigerim/site.git' });
    assert.deepEqual(parseSshUrl('ssh://git@git.company.kz:2222/srv/git/site.git'), { user: 'git', host: 'git.company.kz', port: 2222, path: '/srv/git/site.git' });
    assert.deepEqual(parseSshUrl('ssh://git@git.company.kz/~/site.git'), { user: 'git', host: 'git.company.kz', port: 22, path: 'site.git' });
    assert.deepEqual(parseSshUrl('ssh://deploy@[2a00:1450::1]:22/repo.git').host, '2a00:1450::1');
    assert.equal(sshDisplayUrl(parseSshUrl('ssh://git@git.company.kz:2222/srv/site.git')), 'ssh://git@git.company.kz:2222/srv/site.git');
    assert.equal(sshDisplayUrl(parseSshUrl('git@github.com:a/b.git')), 'git@github.com:a/b.git');
  });
  it('refuses option tricks, parent folders, odd users and ports', () => {
    for (const bad of ['git@-oProxyCommand=x:a/b', 'git@host:../etc/passwd', 'git@host:a/-u.git', '-x@host:a/b', 'https://github.com/a/b', 'ssh://git@host:70000/a', 'git@host:a b', 'ssh://git@host/~root/x', 'git@ho_st:a/b']) {
      assert.throws(() => parseSshUrl(bad), isCode('REPO_SSH_URL_INVALID'), bad);
    }
  });
});

describe('any git over SSH: a real server', async () => {
  const canRun = existsSync('/usr/sbin/sshd') && process.getuid?.() === 0 && await sshToolsAvailable();
  const skip = canRun ? false : 'needs OpenSSH, git and root';
  let dir = ''; let sshd: ChildProcess | null = null; let port = 0;
  before(async () => {
    if (!canRun) return;
    dir = await mkdtemp(path.join(tmpdir(), 'ssh-git-test-'));
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host')]);
    await run('git', ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'bare.git')]);
    port = 30000 + Math.floor(Math.random() * 20000);
    await run('mkdir', ['-p', '/run/sshd']);
    sshd = spawn('/usr/sbin/sshd', ['-D', '-p', String(port), '-h', path.join(dir, 'host'), '-o', 'ListenAddress=127.0.0.1', '-o', `AuthorizedKeysFile=${path.join(dir, 'authorized_keys')}`, '-o', 'StrictModes=no', '-o', 'PermitRootLogin=prohibit-password', '-o', 'PasswordAuthentication=no'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  after(async () => { sshd?.kill(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it('pushes with the deploy key, trusts only the confirmed host key and never overwrites a foreign pipeline', { skip }, async () => {
    const key = await generateDeployKey('buildpath-test');
    assert.match(key.publicKey, /^ssh-ed25519 /);
    assert.match(key.fingerprint, /^SHA256:/);
    await appendFile(path.join(dir, 'authorized_keys'), `${key.publicKey}\n`);
    const remote = parseSshUrl(`ssh://root@localhost:${port}${path.join(dir, 'bare.git')}`);
    const hostKeys = await scanHostKeys(remote, '127.0.0.1');
    assert.equal(hostKeys[0].type, 'ssh-ed25519');
    const knownHosts = hostKeys.map((item) => item.line).join('\n');
    const client = new SshGitClient(remote, '127.0.0.1', key.privateKey, knownHosts);
    assert.deepEqual(await client.inspect(), { branches: [], defaultBranch: null });

    await client.commit('main', [{ path: 'index.html', content: '<html>1</html>' }, { path: 'uslugi/index.html', content: '<p>u</p>' }], 'first');
    const { commit } = await client.commit('main', [{ path: 'index.html', content: '<html>2</html>' }, { path: '.gitlab-ci.yml', content: `# ${CI_MARKER}\n`, marker: CI_MARKER }], 'second');
    const show = (file: string) => run('git', ['--git-dir', path.join(dir, 'bare.git'), 'show', `main:${file}`]).then((result) => result.stdout);
    assert.equal(await show('index.html'), '<html>2</html>');
    assert.equal(await show('uslugi/index.html'), '<p>u</p>');
    assert.equal((await run('git', ['--git-dir', path.join(dir, 'bare.git'), 'rev-parse', 'main'])).stdout.trim(), commit);
    assert.deepEqual(await client.inspect(), { branches: ['main'], defaultBranch: 'main' });

    await assert.rejects(client.commit('main', [{ path: '.gitlab-ci.yml', content: 'mine', marker: 'other-marker' }], 'm'), isCode('REPO_CI_FILE_EXISTS'));
    // The agent's work goes on its own branch made from main; main stays as it was.
    await client.commit('buildpath/agent-1', [{ path: 'server/index.js', content: 'export {};\n' }], 'agent', 'main');
    assert.equal(await show('index.html'), '<html>2</html>');
    assert.equal((await run('git', ['--git-dir', path.join(dir, 'bare.git'), 'show', 'buildpath/agent-1:index.html'])).stdout, '<html>2</html>', 'the branch starts from main');
    assert.equal((await run('git', ['--git-dir', path.join(dir, 'bare.git'), 'show', 'buildpath/agent-1:server/index.js'])).stdout, 'export {};\n');
    await assert.rejects(run('git', ['--git-dir', path.join(dir, 'bare.git'), 'show', 'main:server/index.js']));
    const foreignHost = 'localhost ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    await assert.rejects(new SshGitClient(remote, '127.0.0.1', key.privateKey, foreignHost).inspect(), isCode('REPO_SSH_HOST_KEY_CHANGED'));
    const stranger = await generateDeployKey('stranger');
    await assert.rejects(new SshGitClient(remote, '127.0.0.1', stranger.privateKey, knownHosts).inspect(), isCode('REPO_SSH_KEY_REJECTED'));
    await assert.rejects(new SshGitClient(parseSshUrl(`ssh://root@localhost:${port}${path.join(dir, 'none.git')}`), '127.0.0.1', key.privateKey, knownHosts).inspect(), isCode('REPO_NOT_FOUND'));
    assert.ok((await readFile(path.join(dir, 'authorized_keys'), 'utf8')).includes(key.publicKey));
    // Reading the code back: the files of main from a shallow fetch, without the pipeline's secrets or binaries.
    await client.commit('main', [{ path: '.env', content: 'SECRET=1' }, { path: 'logo.png', content: 'png' }], 'more');
    const snapshot = await client.readBranch('main');
    assert.deepEqual(snapshot!.files.map((file) => file.path), ['.gitlab-ci.yml', 'index.html', 'uslugi/index.html']);
    assert.equal(snapshot!.files.find((file) => file.path === 'index.html')!.content, '<html>2</html>');
    assert.match(snapshot!.commit!, /^[0-9a-f]{40}$/);
    assert.equal(await client.readBranch('nothing-here'), null);
  });

  it('as the owner sees it: create the key, confirm the server, connect, push; a booking site gets its program for auto-deploy', { skip }, async () => {
    let prisma: PrismaService | null = null;
    try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM ssh_deploy_keys LIMIT 1`; } catch { prisma = null; }
    if (!prisma) return;
    const saved = { key: process.env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY, local: process.env.CODE_HOSTING_ALLOW_LOCAL };
    process.env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.CODE_HOSTING_ALLOW_LOCAL = 'true';
    const email = `ssh-${randomUUID()}@test.local`;
    const owner = await prisma.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner', locale: 'ru' } });
    try {
      const workspace = await prisma.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
      await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
      const billing = new BillingService(prisma);
      const core = new JourneyCore(prisma, billing);
      const worktime = new WorktimeService(prisma);
      const stageAi = new StageAiService(prisma, core, worktime);
      const journey = new JourneyService(prisma, billing, worktime, core, stageAi, new ChangeNoticesService(prisma, core), new StageReviewService(prisma, core, stageAi));
      journey.result = (async () => ({ data: { complete: true, files: [{ name: 'site.html', content: '<html>Усы</html>' }] } })) as never;
      const choices = new ChoicesService(prisma, journey);
      const projectId = (await new ProjectsService(prisma, billing).create(owner.id, { workspaceId: workspace.id, name: 'Усы', startMode: 'build', locale: 'ru', projectType: 'booking' } as never)).data.id;
      await choices.choose(owner.id, projectId, 'code_hosting', 'ssh', null);

      const created = (await choices.createSshKey(owner.id, projectId, false)).data.key!;
      assert.equal((await choices.createSshKey(owner.id, projectId, false)).data.key!.fingerprint, created.fingerprint, 'the same key until asked for a new one');
      await appendFile(path.join(dir, 'authorized_keys'), `${created.publicKey}\n`);
      const repoUrl = `ssh://root@localhost:${port}${path.join(dir, 'owner.git')}`;
      await run('git', ['init', '-q', '--bare', '-b', 'main', path.join(dir, 'owner.git')]);
      const scanned = (await choices.sshHostKeys(owner.id, projectId, repoUrl)).data;
      assert.equal(scanned.port, port);
      await assert.rejects(choices.connect(owner.id, projectId, { provider: 'ssh', repoUrl, token: '', hostFingerprint: 'SHA256:not-this-server' }), /REPO_SSH_HOST_KEY_MISMATCH/);
      const card = (await choices.connect(owner.id, projectId, { provider: 'ssh', repoUrl, token: '', hostFingerprint: scanned.keys[0].fingerprint })).data;
      assert.equal(card.repository!.provider, 'ssh');
      assert.equal(card.repository!.defaultBranch, 'main');

      const stage = await prisma.projectStage.findFirst({ where: { projectId, stageKey: 'build' } });
      const version = await prisma.stageArtifactVersion.create({ data: { projectId, stageId: stage!.id, versionNumber: 1, artifactType: 'site', origin: 'ai_generated', createdByUserId: owner.id,
        content: { html: '<html>Усы</html>', compiledAt: new Date().toISOString(), meta: { businessName: 'Усы', locale: 'ru', booking: { services: [], hours: [] } } } as never } });
      await prisma.projectStage.update({ where: { id: stage!.id }, data: { approvedVersionId: version.id } });
      assert.equal((await choices.pushPreview(owner.id, projectId)).data.ci.available, false, 'no pipeline for a plain SSH server');
      await choices.push(owner.id, projectId, true);
      const shown = (await run('git', ['--git-dir', path.join(dir, 'owner.git'), 'show', 'main:index.html'])).stdout;
      assert.equal(shown, '<html>Усы</html>');

      // The same booking site on GitLab: the pipeline goes with the booking program for the server.
      await prisma.codeRepository.update({ where: { projectId }, data: { provider: 'gitlab' } });
      const withCi = (await choices.pushPreview(owner.id, projectId, true)).data;
      assert.equal(withCi.ci.kind, 'booking');
      assert.deepEqual(withCi.files.map((file) => file.path).filter((file) => file.startsWith('server/') || file === '.gitlab-ci.yml'), ['server/app/server.mjs', 'server/app/config.json', 'server/app/index.html', '.gitlab-ci.yml']);

      const rotated = (await choices.createSshKey(owner.id, projectId, true)).data.key!;
      assert.notEqual(rotated.fingerprint, created.fingerprint);
    } finally {
      await prisma.project.deleteMany({ where: { ownerUserId: owner.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: owner.id } });
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.$disconnect();
      for (const [name, value] of [['CODE_HOSTING_TOKEN_ENCRYPTION_KEY', saved.key], ['CODE_HOSTING_ALLOW_LOCAL', saved.local]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
