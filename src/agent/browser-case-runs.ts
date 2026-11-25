import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { costOf } from '../budget/budget.js';
import { PrismaService } from '../database/prisma.service.js';
import { contentLocale } from '../i18n/i18n.js';
import { JourneyCore } from '../journey/journey-core.js';
import { recordRunResults } from '../journey/plan-results.js';
import type { TestPlan } from '../journey/testplan.js';
import type { AppFeatures } from '../journey/webapp.js';
import { configuredAgentModel, type AgentModel } from './agent-model.js';
import { BROWSER_CASE_LIMITS, BROWSER_CASES_VERSION, runBrowserCases, type BrowserCase, type BrowserCaseResult } from './browser-cases.js';

const ACTIVE = ['queued', 'running'];
/** One run checks the browser cases of one preview; its AI spend is capped like an agent task's, but lower. */
const MAX_COST_TIYN = Number(process.env.BROWSER_CASES_MAX_COST_TIYN ?? 30_000);

/** Runs queued browser case runs one at a time: in the worker, and in the API unless SANDBOX_WORKER=external. */
@Injectable()
export class BrowserCaseRunner {
  private readonly logger = new Logger(BrowserCaseRunner.name);
  private busy = false;
  private model: AgentModel | null | undefined;
  run = runBrowserCases;

  constructor(private readonly prisma: PrismaService) {}

  setModel(model: AgentModel | null): void { this.model = model; }
  agentModel(): AgentModel | null { if (this.model === undefined) this.model = configuredAgentModel(); return this.model; }
  browserPath(): string | null { return process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH || null; }

  kick(): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try { while (await this.processNext()); } catch { this.logger.error('Browser case queue failed'); } finally { this.busy = false; }
    })();
  }

  async loop(stopping: () => boolean): Promise<void> {
    await this.prisma.browserCaseRun.updateMany({ where: { status: 'running' }, data: { status: 'failed', errorCode: 'BROWSER_CASES_INTERRUPTED', finishedAt: new Date() } });
    while (!stopping()) {
      try { if (!(await this.processNext())) await new Promise((resolve) => setTimeout(resolve, 3000)); } catch { await new Promise((resolve) => setTimeout(resolve, 5000)); }
    }
  }

  async processNext(): Promise<boolean> {
    const candidate = await this.prisma.browserCaseRun.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!candidate) return false;
    const claimed = await this.prisma.browserCaseRun.updateMany({ where: { id: candidate.id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
    if (claimed.count) await this.process(candidate.id);
    return true;
  }

  async process(id: string): Promise<void> {
    const run = await this.prisma.browserCaseRun.findUnique({ where: { id } });
    if (!run) return;
    const finish = (data: Record<string, unknown>) => this.prisma.browserCaseRun.update({ where: { id }, data: { ...data, finishedAt: new Date() } as never });
    const model = this.agentModel();
    const executablePath = this.browserPath();
    if (!model || !executablePath) { await finish({ status: 'failed', errorCode: 'BROWSER_CASES_NOT_CONFIGURED' }); return; }
    const task = await this.prisma.agentTask.findUnique({ where: { id: run.agentTaskId }, select: { demoHtml: true, locale: true } });
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId: run.projectId, stageKey: 'testplan' }, select: { approvedVersionId: true } });
    const version = stage?.approvedVersionId ? await this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.approvedVersionId }, select: { content: true, versionNumber: true } }) : null;
    if (!task?.demoHtml || !version || version.versionNumber !== run.planVersion) { await finish({ status: 'failed', errorCode: 'BROWSER_CASES_INPUT_CHANGED' }); return; }
    const features = await this.prisma.projectStage.findFirst({ where: { projectId: run.projectId, stageKey: 'features' }, select: { approvedVersionId: true } })
      .then((row) => (row?.approvedVersionId ? this.prisma.stageArtifactVersion.findUnique({ where: { id: row.approvedVersionId }, select: { content: true } }) : null));
    const roles = ((features?.content as unknown as AppFeatures | undefined)?.roles ?? []);
    const cases = (version.content as unknown as TestPlan).cases.filter((item) => run.caseKeys.includes(item.key)) as BrowserCase[];
    const pricing = await this.prisma.aiPricing.findUnique({ where: { id: 1 } });
    const language = contentLocale(task.locale) === 'en' ? 'English' : task.locale === 'kk' ? 'Kazakh' : 'Russian';
    let outcome: Awaited<ReturnType<typeof runBrowserCases>>;
    try {
      outcome = await this.run({
        html: task.demoHtml, cases, model, language, executablePath, maxCostTiyn: MAX_COST_TIYN,
        roleName: (key) => (key ? roles.find((role) => role.key === key)?.name ?? key : 'a visitor who is not signed in'),
        costOf: (usage) => costOf(usage, pricing) ?? 0,
      });
    } catch (error) {
      this.logger.error(`Browser case run ${id} failed: ${(error as Error).name}`);
      await finish({ status: 'failed', errorCode: 'BROWSER_CASES_FAILED' });
      return;
    }
    const decided = outcome.results.filter((item) => item.status !== 'cannot_check');
    await this.prisma.$transaction(async (tx) => {
      // One run counts as one AI request toward the limits; its whole cost goes to the project's spending.
      const testplanStage = await tx.projectStage.findFirstOrThrow({ where: { projectId: run.projectId, stageKey: 'testplan' }, select: { id: true } });
      await tx.generationRun.create({ data: {
        projectId: run.projectId, stageId: testplanStage.id, requestedByUserId: run.requestedByUserId, provider: model.name, model: model.model.slice(0, 80),
        playbookVersion: `browser-cases-${BROWSER_CASES_VERSION}`, targetKey: 'browser_cases', status: outcome.stoppedBy === 'model_error' ? 'failed' : 'succeeded',
        durationMs: Date.now() - (run.startedAt?.getTime() ?? Date.now()), source: 'app', costTiyn: pricing ? outcome.costTiyn : null,
      } });
      await tx.browserCaseRun.update({ where: { id }, data: {
        status: outcome.stoppedBy === 'finished' ? 'succeeded' : 'failed', errorCode: outcome.stoppedBy === 'finished' ? null : outcome.stoppedBy === 'budget' ? 'BROWSER_CASES_BUDGET' : 'AGENT_MODEL_UNAVAILABLE',
        results: outcome.results as never, turns: outcome.turns, costTiyn: outcome.costTiyn, model: model.model.slice(0, 80), finishedAt: new Date(),
      } });
      if (decided.length) await recordRunResults(tx, {
        projectId: run.projectId, agentTaskId: run.agentTaskId, userId: run.requestedByUserId, source: 'browser',
        cases: Object.fromEntries(decided.map((item) => [item.key, item.status as 'passed' | 'failed'])), notes: Object.fromEntries(decided.map((item) => [item.key, item.observed])),
      });
    });
  }
}

@Injectable()
export class BrowserCaseRunsService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly runner: BrowserCaseRunner) {}

  private view(run: { id: string; agentTaskId: string; status: string; results: unknown; turns: number; costTiyn: number; errorCode: string | null; createdAt: Date; finishedAt: Date | null; caseKeys: string[] }) {
    return { id: run.id, agentTaskId: run.agentTaskId, status: run.status, caseKeys: run.caseKeys, results: run.results as BrowserCaseResult[], turns: run.turns, costTiyn: run.costTiyn, errorCode: run.errorCode, createdAt: run.createdAt, finishedAt: run.finishedAt };
  }

  async latest(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read', 'testplan');
    const run = await this.prisma.browserCaseRun.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    const preview = await this.prisma.agentTask.findFirst({ where: { projectId, demoBytes: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
    return { data: { run: run ? this.view(run) : null, preview, configured: Boolean(this.runner.agentModel()) && Boolean(this.runner.browserPath()), canStart: this.core.canWrite(ctx, 'testplan') && !(run && ACTIVE.includes(run.status)) } };
  }

  /** The agent's test code for a case: from the task whose run recorded it, or the newest task with code. */
  async caseTest(userId: string, projectId: string, caseKey: string) {
    await this.core.load(userId, projectId, 'read', 'testplan');
    const result = await this.prisma.planCaseResult.findUnique({ where: { projectId_caseKey: { projectId, caseKey } }, select: { agentTaskId: true, source: true } });
    const task = result?.source === 'run' && result.agentTaskId
      ? await this.prisma.agentTask.findFirst({ where: { id: result.agentTaskId, projectId }, select: { id: true, files: true } })
      : await this.prisma.agentTask.findFirst({ where: { projectId, filesDigest: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, files: true } });
    if (!task) return { data: { agentTaskId: null, tests: [] } };
    return { data: { agentTaskId: task.id, tests: findCaseTests((task.files ?? []) as unknown as Array<{ path: string; content: string }>, caseKey) } };
  }

  /** Queues the browser cases of the accepted test plan against the newest preview the agent built. */
  async start(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'write', 'testplan');
    if (!this.runner.agentModel() || !this.runner.browserPath()) throw new ServiceUnavailableException('BROWSER_CASES_NOT_CONFIGURED');
    const stage = this.core.stageOf(ctx, 'testplan');
    const version = stage.approvedVersionId ? await this.core.versionContent(stage.approvedVersionId) : null;
    if (!version) throw new ConflictException('TESTPLAN_NOT_APPROVED');
    const cases = (version.content as unknown as TestPlan).cases.filter((item) => item.method === 'ai_browser').slice(0, BROWSER_CASE_LIMITS.cases);
    if (!cases.length) throw new BadRequestException('NO_BROWSER_CASES');
    const preview = await this.prisma.agentTask.findFirst({ where: { projectId, demoBytes: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (!preview) throw new NotFoundException('PREVIEW_NOT_BUILT');
    if (await this.core.remainingAiRuns(projectId) < 1) throw new HttpException('AI_DAILY_LIMIT_REACHED', HttpStatus.TOO_MANY_REQUESTS);
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-cases:${projectId}`}))`;
      if (await tx.browserCaseRun.count({ where: { projectId, status: { in: ACTIVE } } })) throw new ConflictException('BROWSER_CASES_RUNNING');
      const created = await tx.browserCaseRun.create({ data: { projectId, agentTaskId: preview.id, planVersion: version.versionNumber, caseKeys: cases.map((item) => item.key), requestedByUserId: userId } });
      await this.core.event(tx, projectId, userId, 'browser_cases_started', 'testplan', { runId: created.id, agentTaskId: preview.id, cases: cases.length });
      return created;
    });
    if (process.env.SANDBOX_WORKER !== 'external') this.runner.kick();
    return { data: this.view(run) };
  }
}

/**
 * The test that proves a case, as the agent wrote it: the call whose name holds [case:<key>], from the test file up to the
 * line that closes it at the same indentation (at most 60 lines). Several tests for one case are all returned.
 */
export function findCaseTests(files: Array<{ path: string; content: string }>, key: string): Array<{ path: string; line: number; code: string }> {
  const out: Array<{ path: string; line: number; code: string }> = [];
  const marker = `[case:${key}]`;
  for (const file of files.filter((item) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//.test(item.path))) {
    const lines = file.content.split('\n');
    lines.forEach((text, index) => {
      if (!text.includes(marker) || out.length >= 5) return;
      // The marker can follow it on the same line only when it is the test's own name, not a comment mentioning it.
      if (!/\b(test|it|describe)\s*\(/.test(text)) return;
      const indent = /^\s*/.exec(text)![0].length;
      let end = index;
      for (let n = index + 1; n < Math.min(lines.length, index + 60); n += 1) {
        end = n;
        const line = lines[n]!;
        if (line.trim() && /^\s*/.exec(line)![0].length <= indent && /^\s*\}\s*\)?\s*;?\s*$|^\s*\)\s*;?\s*$/.test(line)) break;
      }
      if (/\)\s*;?\s*$/.test(text) && end === index + 1 && !lines[index + 1]?.trim()) end = index;
      out.push({ path: file.path, line: index + 1, code: lines.slice(index, end + 1).join('\n') });
    });
  }
  return out;
}
