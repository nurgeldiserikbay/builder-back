import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Brief } from '../journey/artifacts.js';
import { ChangeNoticesService } from '../journey/change-notices.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { JourneyService } from '../journey/journey.service.js';
import { templateProcess } from '../journey/process.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { StageReviewService } from '../journey/stage-review.service.js';
import { buildStarterCode } from '../journey/starter-code.js';
import { buildAppPlan, templateFeatures, templateScreens } from '../journey/webapp.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { configuredSandbox, E2BSandboxProvider, SandboxError, tail, WORKDIR, type E2BCommandResult, type E2BSdk, type SandboxProvider, type SandboxRequest } from './sandbox.js';
import { SandboxRunner, STARTER_COMMANDS, STARTER_RUNS_PER_VERSION, StarterChecksService } from './starter-checks.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

function starter() {
  const process = templateProcess('web_app', brief);
  const features = templateFeatures(brief, process);
  const plan = buildAppPlan({ brief, process, features, screens: templateScreens(features) }, null);
  return { features, plan, code: buildStarterCode({ brief, features, plan, locale: 'ru' }) };
}

class CommandExit extends Error { constructor(readonly result: E2BCommandResult) { super('exit'); } }
class Timeout extends Error {}

/** Stands in for the E2B SDK: records what the adapter sends and answers with scripted results. */
function fakeSdk(answer: (cmd: string) => E2BCommandResult | Error, options: { failCreate?: boolean } = {}) {
  const log = { created: [] as unknown[], written: [] as Array<{ path: string; data: string }>, commands: [] as Array<{ cmd: string; cwd?: string; envs?: Record<string, string> }>, killed: 0 };
  const sdk: E2BSdk = {
    async create(template, opts) {
      if (options.failCreate) throw new Error('quota');
      log.created.push({ template, ...opts, apiKey: opts.apiKey ? 'set' : '' });
      return {
        files: { write: async (files) => { log.written.push(...files); } },
        commands: {
          run: async (cmd, opts) => {
            log.commands.push({ cmd, cwd: opts.cwd, envs: opts.envs });
            const result = answer(cmd);
            if (result instanceof Error) throw result;
            if (result.exitCode !== 0) throw new CommandExit(result);
            return result;
          },
        },
        kill: async () => { log.killed += 1; },
      };
    },
    exitResult: (error) => (error instanceof CommandExit ? error.result : null),
    isTimeout: (error) => error instanceof Timeout,
  };
  return { sdk, log };
}

const request = (files = [{ path: 'a.js', content: 'x' }]): SandboxRequest => ({ files, commands: STARTER_COMMANDS, internet: false, lifetimeMs: 60_000, labels: { kind: 'test' } });

describe('starter code of a web application', () => {
  it('follows the data schema and role rights of the package', () => {
    const { features, plan, code } = starter();
    const names = code.files.map((file) => file.path);
    assert.deepEqual(names, ['package.json', 'README.md', 'src/schema.js', 'src/app.js', 'src/rules.js', 'src/server.js', 'test/api.test.js']);
    assert.equal(code.collections.length, plan.dataModel.filter((entity) => entity.key !== 'user').length);
    const schema = code.files.find((file) => file.path === 'src/schema.js')!.content;
    for (const role of features.roles) assert.ok(schema.includes(JSON.stringify(role.key)), role.key);
    // No dependencies to install: the sandbox needs no internet.
    const pkg = JSON.parse(code.files.find((file) => file.path === 'package.json')!.content) as Record<string, unknown>;
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.match(code.files.find((file) => file.path === 'README.md')!.content, /x-demo-role/);
  });

  it('is the same for the same inputs', () => {
    assert.deepEqual(starter().code, starter().code);
  });

  it('its own tests pass on Node.js', () => {
    // Tests of the platform may run the generated code; the API and the worker never do.
    const dir = mkdtempSync(join(tmpdir(), 'starter-'));
    try {
      for (const file of starter().code.files) { mkdirSync(dirname(join(dir, file.path)), { recursive: true }); writeFileSync(join(dir, file.path), file.content); }
      const output = execFileSync(process.execPath, ['--test'], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 60_000 });
      assert.match(output, /# fail 0/);
      assert.match(output, /has no access|# pass/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('E2B sandbox adapter', () => {
  it('writes the files into the project folder, runs every step offline and destroys the machine', async () => {
    const { sdk, log } = fakeSdk(() => ({ exitCode: 0, stdout: '\u001b[32mok\u001b[0m', stderr: '' }));
    const result = await new E2BSandboxProvider('key', 'base', async () => sdk).run(request());
    assert.deepEqual(result.commands.map((command) => command.status), ['passed', 'passed', 'passed']);
    assert.equal(result.commands[0]!.stdout, 'ok');
    assert.deepEqual(log.written, [{ path: `${WORKDIR}/a.js`, data: 'x' }]);
    assert.equal((log.created[0] as { allowInternetAccess: boolean }).allowInternetAccess, false);
    assert.ok(log.commands.every((command) => command.cwd === WORKDIR && JSON.stringify(command.envs) === '{"CI":"1"}'));
    assert.equal(log.killed, 1);
  });

  it('stops at the first failed step and keeps its output', async () => {
    const { sdk, log } = fakeSdk((cmd) => (cmd.includes('--check') ? { exitCode: 1, stdout: '', stderr: 'SyntaxError: x' } : { exitCode: 0, stdout: 'v22', stderr: '' }));
    const result = await new E2BSandboxProvider('key', 'base', async () => sdk).run(request());
    assert.deepEqual(result.commands.map((command) => command.status), ['passed', 'failed', 'skipped']);
    assert.equal(result.commands[1]!.stderr, 'SyntaxError: x');
    assert.equal(log.commands.length, 2);
    assert.equal(log.killed, 1);
  });

  it('reports timeouts and provider failures truthfully and always destroys the machine', async () => {
    const timed = fakeSdk((cmd) => (cmd.startsWith('node --test') ? new Timeout() : { exitCode: 0, stdout: '', stderr: '' }));
    assert.equal((await new E2BSandboxProvider('key', 'base', async () => timed.sdk).run(request())).commands[2]!.status, 'timed_out');
    const broken = fakeSdk(() => new Error('connection lost'));
    await assert.rejects(new E2BSandboxProvider('key', 'base', async () => broken.sdk).run(request()), (error: unknown) => error instanceof SandboxError && error.code === 'SANDBOX_FAILED');
    assert.equal(broken.log.killed, 1);
    const refused = fakeSdk(() => ({ exitCode: 0, stdout: '', stderr: '' }), { failCreate: true });
    await assert.rejects(new E2BSandboxProvider('key', 'base', async () => refused.sdk).run(request()), (error: unknown) => error instanceof SandboxError && error.code === 'SANDBOX_START_FAILED');
  });

  it('keeps only the end of long output and is off without a key', () => {
    assert.equal(tail('a'.repeat(7000)).length, 6001);
    const saved = { provider: process.env.SANDBOX_PROVIDER, key: process.env.E2B_API_KEY };
    try {
      process.env.SANDBOX_PROVIDER = 'e2b'; delete process.env.E2B_API_KEY;
      assert.equal(configuredSandbox(), null);
      process.env.E2B_API_KEY = 'k';
      assert.equal(configuredSandbox()?.name, 'e2b');
    } finally {
      if (saved.provider === undefined) delete process.env.SANDBOX_PROVIDER; else process.env.SANDBOX_PROVIDER = saved.provider;
      if (saved.key === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = saved.key;
    }
  });
});

describe('starter code check (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM sandbox_runs LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('queues the tests of the current package, runs them in the sandbox and gives the files', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const email = `starter-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Клин', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const accept = async (key: string) => journey.accept(owner.id, projectId, key, (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!);
    await journey.saveDraft(owner.id, projectId, 'goal', { content: brief, baseVersionId: null });
    await accept('goal');
    await journey.skip(owner.id, projectId, 'idea', 'Идея уже проверена — бизнес работает');
    await journey.skip(owner.id, projectId, 'suggestions', 'Знаем, что войдёт в первую версию');
    await journey.skip(owner.id, projectId, 'concept', 'Документ для других пока не нужен');
    for (const key of ['process', 'features', 'screens']) { await journey.generate(owner.id, projectId, key, { instruction: null, saveAs: 'one_off', targetKey: null }); await accept(key); }
    await journey.saveDraft(owner.id, projectId, 'techplan', { content: { ownerNotes: null }, baseVersionId: null });
    await accept('techplan');
    await journey.saveDraft(owner.id, projectId, 'contracts', { content: ((await journey.stage(owner.id, projectId, 'contracts')).data.options.contracts as { template: unknown }).template, baseVersionId: null });
    await accept('contracts');
    await journey.saveDraft(owner.id, projectId, 'roadmap', { content: ((await journey.stage(owner.id, projectId, 'roadmap')).data.options.roadmap as { template: unknown }).template, baseVersionId: null });
    await accept('roadmap');
    await journey.saveDraft(owner.id, projectId, 'testplan', { content: ((await journey.stage(owner.id, projectId, 'testplan')).data.options.testplan as { template: unknown }).template, baseVersionId: null });
    await accept('testplan');

    const runner = new SandboxRunner(prisma!);
    const service = new StarterChecksService(prisma!, core, runner);
    process.env.SANDBOX_WORKER = 'external';
    try {
      await assert.rejects(service.start(owner.id, projectId), /HANDOFF_NOT_BUILT/);
      await journey.buildHandoff(owner.id, projectId);

      // Without a sandbox the check says so instead of pretending the code ran.
      runner.setProvider(null);
      await service.start(owner.id, projectId);
      await assert.rejects(service.start(owner.id, projectId), /STARTER_CHECK_RUNNING/);
      while (await runner.processNext());
      let view = (await service.get(owner.id, projectId)).data;
      assert.equal(view.run!.status, 'unavailable');
      assert.match(view.run!.error!, /не подключена/);
      assert.equal(view.configured, false);

      const seen: SandboxRequest[] = [];
      const fake: SandboxProvider = { name: 'fake', run: async (req) => { seen.push(req); return { provider: 'fake', durationMs: 5, commands: req.commands.map((command) => ({ id: command.id, status: 'passed' as const, exitCode: 0, durationMs: 1, stdout: command.id === 'tests' ? '# pass 9\n# fail 0' : '', stderr: '' })) }; } };
      runner.setProvider(fake);
      await service.start(owner.id, projectId);
      while (await runner.processNext());
      view = (await service.get(owner.id, projectId)).data;
      assert.equal(view.run!.status, 'succeeded');
      assert.equal(view.run!.outdated, false);
      assert.deepEqual(view.run!.steps.map((step) => step.status), ['passed', 'passed', 'passed']);
      assert.match(view.run!.steps[2]!.output, /# fail 0/);
      assert.equal(seen[0]!.internet, false);
      assert.equal(view.runsLeft, STARTER_RUNS_PER_VERSION - 2);
      const files = (await service.files(owner.id, projectId)).data.files;
      assert.deepEqual(files.map((file) => file.path), seen[0]!.files.map((file) => file.path));

      // A tampered queue entry is not run.
      const run = await prisma!.sandboxRun.create({ data: { projectId, kind: 'starter_check', sourceVersionId: (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: 'handoff' } })).currentVersionId!, files: [{ path: 'x.js', content: 'evil' }], filesDigest: '0'.repeat(64), requestedByUserId: owner.id } });
      while (await runner.processNext());
      assert.equal((await prisma!.sandboxRun.findUniqueOrThrow({ where: { id: run.id } })).errorCode, 'CHECK_FAILED');
      assert.equal(seen.length, 1);

      // A rebuilt package makes the last check outdated; people outside the project see nothing.
      await journey.buildHandoff(owner.id, projectId);
      await prisma!.sandboxRun.delete({ where: { id: run.id } });
      assert.equal((await service.get(owner.id, projectId)).data.run!.outdated, true);
      const stranger = await prisma!.user.create({ data: { email: `x-${email}`, emailNormalized: `x-${email}`, passwordHash: 'x', name: 'X' } });
      users.push(stranger.id);
      await assert.rejects(service.get(stranger.id, projectId), /PROJECT_NOT_FOUND/);
      await assert.rejects(service.start(stranger.id, projectId), /PROJECT_NOT_FOUND/);
    } finally { delete process.env.SANDBOX_WORKER; }
  });
});
