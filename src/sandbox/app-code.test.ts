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
import type { StageAiProvider, StageAiRequest } from '../journey/stage-ai.js';
import { StageAiService } from '../journey/stage-ai.service.js';
import { StageReviewService } from '../journey/stage-review.service.js';
import { buildStarterCode, RULES_PATH, RULES_TESTS_PATH } from '../journey/starter-code.js';
import { buildAppPlan, templateFeatures, templateScreens } from '../journey/webapp.js';
import { WorktimeService } from '../journey/worktime.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { AppCodeService, buildAppCodePrompt, normalizeAnswer } from './app-code.js';
import { checkFile, checkFiles } from './code-policy.js';
import type { SandboxProvider } from './sandbox.js';
import { SandboxRunner } from './starter-checks.js';

const brief: Brief = { businessName: 'Сервис Клин', whatYouDo: 'Уборка квартир по заявкам', audience: 'Жители города', city: 'Алматы', mainAction: 'form', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };

function starter() {
  const process = templateProcess('web_app', brief);
  const features = templateFeatures(brief, process);
  const plan = buildAppPlan({ brief, process, features, screens: templateScreens(features) }, null);
  return { process, features, code: buildStarterCode({ brief, features, plan, locale: 'ru' }) };
}

/** What a good AI answer looks like for the template app: clients see and change only their own requests. */
function goodAnswer(collection: string, client: string, owner: string) {
  return {
    rulesCode: `import { collections } from './schema.js';

export function check({ action, collection, user, record }) {
  if (!collections[collection]) return null;
  if (user.role === ${JSON.stringify(owner)}) return null;
  if (record && record.created_by !== user.id) {
    if (action === 'read') return { status: 403, error: 'NOT_YOURS', message: 'Это чужая заявка.' };
    return { status: 403, error: 'NOT_YOURS', message: 'Менять можно только свои заявки.' };
  }
  return null;
}
`,
    testsCode: `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

let server; let base;
before(async () => { server = createServer(createApp()); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port + '/api'; });
after(() => new Promise((resolve) => server.close(resolve)));
const call = (path, role, user, method = 'GET', body) => fetch(base + path, { method, headers: { 'x-demo-role': role, 'x-demo-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('a client sees only own requests; the owner sees all', async () => {
  const mine = await (await call('/${collection}', ${JSON.stringify(client)}, 'anna', 'POST', {})).json();
  await call('/${collection}', ${JSON.stringify(client)}, 'boris', 'POST', {});
  const seen = await (await call('/${collection}', ${JSON.stringify(client)}, 'anna')).json();
  assert.deepEqual(seen.map((item) => item.id), [mine.id]);
  assert.equal((await (await call('/${collection}', ${JSON.stringify(owner)}, 'olga')).json()).length, 2);
  assert.equal((await call('/${collection}/' + mine.id, ${JSON.stringify(client)}, 'boris')).status, 404);
  assert.equal((await call('/${collection}/' + mine.id, ${JSON.stringify(client)}, 'boris', 'DELETE')).status, 404);
});
`,
    covered: [{ rule: 'Клиент видит только свои заявки', how: 'check скрывает чужие записи' }],
    notCovered: [{ rule: 'Уведомление владельцу', reason: 'Отправка сообщений — вне API' }],
  };
}

describe('AI-written business rules: code policy', () => {
  it('accepts the rules file and its tests as described to the AI', () => {
    const { features, code } = starter();
    const answer = goodAnswer(code.collections[0]!, features.roles[0]!.key, features.roles[1]!.key);
    assert.deepEqual(checkFiles([{ path: RULES_PATH, content: answer.rulesCode }, { path: RULES_TESTS_PATH, content: answer.testsCode }]), []);
  });

  it('refuses code that reaches the process, the network, the file system or builds code from strings', () => {
    const cases: Array<[string, RegExp]> = [
      ["import fs from 'node:fs';\nexport function check() { return null; }", /node:fs/],
      ['export function check() { return process.env.SECRET; }', /process/],
      ["export function check() { return require('child_process'); }", /require/],
      ["export function check() { return eval('1'); }", /eval/],
      ["export function check() { return (() => {}).constructor('return 1')(); }", /constructor/],
      ["export function check() { return ({})['constructor']; }", /constructor/],
      ["export async function check() { await import('node:fs'); }", /Динамический import/],
      ["export function check() { fetch('https://example.com'); return null; }", /сеть/],
      ['export function check() { return globalThis; }', /globalThis/],
      ['export function rules() { return null; }', /export function check/],
      ['export function check( {', /не разбирается/],
    ];
    for (const [code, message] of cases) {
      const issues = checkFile(RULES_PATH, code);
      assert.ok(issues.some((issue) => message.test(issue.message)), `${code} → ${JSON.stringify(issues)}`);
    }
    // A property that happens to be called process is not the global.
    assert.deepEqual(checkFile(RULES_PATH, 'export function check({ record }) { return record.process ? null : { process: 1 } && null; }'), []);
    assert.ok(checkFile('src/app.js', 'x').length === 1);
    assert.ok(checkFile(RULES_TESTS_PATH, "import assert from 'node:assert/strict';\nassert.ok(true);").some((issue) => /нет ни одного теста/.test(issue.message)));
    assert.ok(checkFiles([{ path: RULES_PATH, content: 'export function check() { return null; }' }]).some((issue) => issue.file === RULES_TESTS_PATH));
  });

  it('the prompt carries the schema, roles, acceptance criteria, business rules and the request as data', () => {
    const { process, features, code } = starter();
    const prompt = buildAppCodePrompt({ starter: code, features, process, instruction: 'Клиент видит только свои заявки', locale: 'ru' });
    const user = JSON.parse(prompt.user) as Record<string, unknown>;
    assert.deepEqual(Object.keys(user.collections as object), code.collections);
    assert.equal(user.ownerRequest, 'Клиент видит только свои заявки');
    assert.deepEqual(user.businessRules, process.rules);
    assert.match(prompt.system, /Russian/);
    assert.throws(() => normalizeAnswer({ rulesCode: 1 }), /AI_INVALID_RESPONSE/);
    assert.equal(normalizeAnswer({ rulesCode: 'a', testsCode: 'b', covered: [{ rule: '', how: 'x' }, { rule: 'r', how: 'h' }] }).covered.length, 1);
  });

  it('the starter with the rules passes both the platform tests and the rule tests on Node.js', () => {
    const { features, code } = starter();
    const answer = goodAnswer(code.collections[0]!, features.roles[0]!.key, features.roles[1]!.key);
    const files = code.files.filter((file) => file.path !== RULES_PATH).concat([{ path: RULES_PATH, content: answer.rulesCode }, { path: RULES_TESTS_PATH, content: answer.testsCode }]);
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    try {
      for (const file of files) { mkdirSync(dirname(join(dir, file.path)), { recursive: true }); writeFileSync(join(dir, file.path), file.content); }
      const output = execFileSync(process.execPath, ['--test'], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 60_000 });
      assert.match(output, /# fail 0/);
      assert.match(output, /sees only own requests/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('AI-written business rules (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT meta FROM sandbox_runs LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('asks the AI once, refuses code that breaks the policy, queues compliant code for the sandbox', { skip }, async () => {
    const billing = new BillingService(prisma!);
    const core = new JourneyCore(prisma!, billing);
    core.provider = null;
    const worktime = new WorktimeService(prisma!);
    const journey = new JourneyService(prisma!, billing, worktime, core, new StageAiService(prisma!, core, worktime), new ChangeNoticesService(prisma!, core), new StageReviewService(prisma!, core, new StageAiService(prisma!, core, worktime)));
    const email = `appcode-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date(), name: 'Owner' } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
    const projectId = (await new ProjectsService(prisma!, billing).create(owner.id, { workspaceId: workspace.id, name: 'Клин', startMode: 'build', locale: 'ru', projectType: 'web_app' } as never)).data.id;
    const accept = async (key: string) => journey.accept(owner.id, projectId, key, (await prisma!.projectStage.findFirstOrThrow({ where: { projectId, stageKey: key } })).currentVersionId!);
    await journey.saveDraft(owner.id, projectId, 'story', { content: { name: 'Сервис Клин', essence: 'Уборка квартир по заявкам', audience: 'Жители города', problem: 'Заявки на уборку теряются в мессенджере', story: null, materials: null }, baseVersionId: null });
    await accept('story');
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
    await journey.buildHandoff(owner.id, projectId);

    const runner = new SandboxRunner(prisma!);
    const service = new AppCodeService(prisma!, core, runner);
    process.env.SANDBOX_WORKER = 'external';
    try {
      // Without AI there is nothing to write the rules.
      assert.equal((await service.get(owner.id, projectId)).data.canGenerate, false);
      await assert.rejects(service.generate(owner.id, projectId, { instruction: null }), /AI_NOT_CONFIGURED/);

      const { features, code } = starter();
      const prompts: StageAiRequest[] = [];
      let answer: unknown = { ...goodAnswer(code.collections[0]!, features.roles[0]!.key, features.roles[1]!.key), rulesCode: "export function check() { return process.env.X ? null : null; }" };
      const ai: StageAiProvider = { name: 'fake', model: 'fake-1', generate: async (request) => { prompts.push(request); return answer; } };
      core.setProvider(ai);
      let view = (await service.generate(owner.id, projectId, { instruction: 'Клиент видит только свои заявки' })).data;
      assert.equal(view.run!.status, 'rejected');
      assert.ok(view.run!.issues.some((issue) => /process/.test(issue.message)));
      assert.match(view.run!.error!, /нарушает правила платформы/);
      await assert.rejects(service.files(owner.id, projectId), /APP_CODE_REJECTED/);
      assert.equal(await prisma!.sandboxRun.count({ where: { projectId, status: 'queued' } }), 0);

      answer = goodAnswer(code.collections[0]!, features.roles[0]!.key, features.roles[1]!.key);
      const sent: string[][] = [];
      const sandbox: SandboxProvider = { name: 'fake', run: async (request) => { sent.push(request.files.map((file) => file.path)); return { provider: 'fake', durationMs: 3, commands: request.commands.map((command) => ({ id: command.id, status: 'passed' as const, exitCode: 0, durationMs: 1, stdout: '', stderr: '' })) }; } };
      runner.setProvider(sandbox);
      view = (await service.generate(owner.id, projectId, { instruction: null })).data;
      assert.equal(view.run!.status, 'queued');
      assert.equal(view.canGenerate, false);
      await assert.rejects(service.generate(owner.id, projectId, { instruction: null }), /APP_CODE_RUNNING/);
      while (await runner.processNext());
      view = (await service.get(owner.id, projectId)).data;
      assert.equal(view.run!.status, 'succeeded');
      assert.deepEqual(view.run!.covered.map((item) => item.rule), ['Клиент видит только свои заявки']);
      assert.equal(view.run!.notCovered.length, 1);
      assert.match(view.run!.rulesCode!, /export function check/);
      assert.ok(sent[0]!.includes(RULES_TESTS_PATH) && sent[0]!.includes('test/api.test.js'));
      assert.ok((await service.files(owner.id, projectId)).data.files.some((file) => file.path === RULES_PATH));
      // Both requests were counted as AI runs, including the rejected one.
      const runs = await prisma!.generationRun.findMany({ where: { projectId, targetKey: 'app_code' }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(runs.map((run) => run.status), ['failed', 'succeeded']);
      assert.equal(runs[0]!.safeErrorCode, 'AI_OUTPUT_REJECTED');
      assert.equal((JSON.parse(prompts[0]!.user) as { ownerRequest: string }).ownerRequest, 'Клиент видит только свои заявки');
      await assert.rejects(service.generate(owner.id, projectId, { instruction: 'x'.repeat(1001) }), /INSTRUCTION_TOO_LONG/);
    } finally { delete process.env.SANDBOX_WORKER; core.setProvider(null); }
  });
});
