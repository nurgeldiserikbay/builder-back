import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import type { Brief } from '../journey/artifacts.js';
import { inputsSatisfied } from '../journey/stage-state.js';
import { JourneyCore } from '../journey/journey-core.js';
import { buildStarterCode, STARTER_NODE_MAJOR, type StarterFile } from '../journey/starter-code.js';
import type { TechPlan } from '../journey/techplan.js';
import type { AppFeatures } from '../journey/webapp.js';
import { configuredSandbox, SandboxError, type SandboxCommand, type SandboxProvider, type SandboxResult } from './sandbox.js';

const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
export const STARTER_RUNS_PER_VERSION = 5;
const KIND = 'starter_check';

/** What runs in the sandbox, in order; a failed step skips the rest. The machine has no internet: the code needs no packages. */
export const STARTER_COMMANDS: SandboxCommand[] = [
  { id: 'node', run: `node -e "process.exit(Number(process.versions.node.split('.')[0]) >= ${STARTER_NODE_MAJOR} ? 0 : 3)" && node --version`, timeoutMs: 20_000 },
  { id: 'syntax', run: 'node --check src/schema.js && node --check src/app.js && node --check src/server.js && node --check test/api.test.js', timeoutMs: 30_000 },
  { id: 'tests', run: 'node --test --test-reporter=spec', timeoutMs: 120_000 },
];
const commandLabels: Record<string, string> = { node: 'Node.js {0} или новее', syntax: 'Код читается без ошибок', tests: 'Тесты API проходят' };
const statusLabels: Record<string, string> = { queued: 'В очереди', running: 'Идёт проверка', succeeded: 'Тесты прошли', failed: 'Тесты не прошли', unavailable: 'Проверка недоступна' };
const errorLabels: Record<string, string> = {
  SANDBOX_NOT_CONFIGURED: 'Изолированная среда для запуска кода не подключена на этом сервере. Код можно скачать; он не запускался.',
  SANDBOX_START_FAILED: 'Изолированная среда не запустилась. Попробуйте ещё раз позже.',
  SANDBOX_UPLOAD_FAILED: 'Файлы не загрузились в изолированную среду. Попробуйте ещё раз.',
  SANDBOX_FAILED: 'Проверка прервалась из-за ошибки изолированной среды.',
  CHECK_FAILED: 'Проверка прервалась из-за внутренней ошибки.',
};

export const digestOf = (files: StarterFile[]) => createHash('sha256').update(JSON.stringify(files)).digest('hex');

/** Runs queued sandbox checks one at a time. Code executes at the sandbox provider; this process only sends files and reads results. */
@Injectable()
export class SandboxRunner {
  private readonly logger = new Logger(SandboxRunner.name);
  private busy = false;
  private provider: SandboxProvider | null | undefined;

  constructor(private readonly prisma: PrismaService) {}

  /** Tests inject a provider; production reads SANDBOX_PROVIDER and E2B_API_KEY. */
  setProvider(provider: SandboxProvider | null): void { this.provider = provider; }
  sandbox(): SandboxProvider | null {
    if (this.provider === undefined) this.provider = configuredSandbox();
    return this.provider;
  }

  kick(): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try { while (await this.processNext()); } catch { this.logger.error('Sandbox queue failed'); } finally { this.busy = false; }
    })();
  }

  async loop(stopping: () => boolean): Promise<void> {
    this.logger.log('Sandbox worker started');
    while (!stopping()) {
      try { if (!(await this.processNext())) await new Promise((resolve) => setTimeout(resolve, 3000)); } catch { await new Promise((resolve) => setTimeout(resolve, 5000)); }
    }
  }

  async claim(): Promise<string | null> {
    const stale = new Date(Date.now() - STALE_MS);
    const candidate = await this.prisma.sandboxRun.findFirst({
      where: { OR: [{ status: 'queued' }, { status: 'running', startedAt: { lt: stale }, attemptCount: { lt: MAX_ATTEMPTS } }] },
      orderBy: { createdAt: 'asc' }, select: { id: true, status: true, startedAt: true },
    });
    if (!candidate) return null;
    const claimed = await this.prisma.sandboxRun.updateMany({ where: { id: candidate.id, status: candidate.status, startedAt: candidate.startedAt }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
    return claimed.count === 1 ? candidate.id : null;
  }

  async processNext(): Promise<boolean> {
    const id = await this.claim();
    if (!id) return false;
    await this.process(id);
    return true;
  }

  async process(id: string): Promise<void> {
    const run = await this.prisma.sandboxRun.findUnique({ where: { id }, select: { id: true, projectId: true, status: true, files: true, filesDigest: true } });
    if (!run || run.status !== 'running') return;
    const finish = (data: { status: string; result?: SandboxResult; errorCode?: string | null; provider?: string | null }) =>
      this.prisma.sandboxRun.updateMany({ where: { id, status: 'running' }, data: { status: data.status, result: (data.result ?? undefined) as never, errorCode: data.errorCode ?? null, provider: data.provider ?? null, finishedAt: new Date() } });
    const sandbox = this.sandbox();
    if (!sandbox) { await finish({ status: 'unavailable', errorCode: 'SANDBOX_NOT_CONFIGURED' }); return; }
    const files = run.files as unknown as StarterFile[];
    // The stored files are what the owner downloads; refuse to run anything that changed after it was queued.
    if (digestOf(files) !== run.filesDigest) { await finish({ status: 'failed', errorCode: 'CHECK_FAILED' }); return; }
    try {
      const result = await sandbox.run({ files, commands: STARTER_COMMANDS, internet: false, lifetimeMs: 5 * 60_000, labels: { kind: KIND, run: id } });
      const passed = result.commands.length === STARTER_COMMANDS.length && result.commands.every((command) => command.status === 'passed');
      await finish({ status: passed ? 'succeeded' : 'failed', result, provider: result.provider });
    } catch (error) {
      await finish({ status: 'failed', errorCode: error instanceof SandboxError ? error.code : 'CHECK_FAILED', provider: sandbox.name });
    }
  }
}

type RunRow = { id: string; sourceVersionId: string; status: string; result: unknown; errorCode: string | null; provider: string | null; createdAt: Date; finishedAt: Date | null; files: unknown };

/**
 * «Стартовый код» on the «Пакет для разработки» stage: the platform turns the accepted package into a
 * dependency-free API with tests and runs those tests in an isolated sandbox. Nothing is published or pushed.
 */
@Injectable()
export class StarterChecksService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly runner: SandboxRunner) {}

  onApplicationBootstrap(): void {
    if (process.env.SANDBOX_WORKER === 'external' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => this.runner.kick(), 10_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private view(run: RunRow | null, currentVersionId: string | null) {
    if (!run) return null;
    const result = run.result as SandboxResult | null;
    return {
      id: run.id, status: run.status, statusLabel: tr(statusLabels[run.status] ?? run.status), createdAt: run.createdAt, finishedAt: run.finishedAt,
      // A check of an older package says nothing about the current one.
      outdated: run.sourceVersionId !== currentVersionId,
      provider: run.provider,
      error: run.errorCode ? tr(errorLabels[run.errorCode] ?? 'Проверка не получилась.') : null,
      steps: STARTER_COMMANDS.map((command) => {
        const done = result?.commands.find((item) => item.id === command.id);
        return { id: command.id, label: tr(commandLabels[command.id]!, [String(STARTER_NODE_MAJOR)]), status: done?.status ?? null, durationMs: done?.durationMs ?? null, output: done && done.status !== 'passed' ? [done.stdout, done.stderr].filter(Boolean).join('\n') : (command.id === 'tests' && done ? done.stdout : '') };
      }),
      files: (run.files as StarterFile[]).map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })),
    };
  }

  private async context(userId: string, projectId: string, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access, 'handoff');
    if (ctx.type.key !== 'web_app') throw new NotFoundException('STAGE_NOT_FOUND');
    return { ctx, stage: this.core.stageOf(ctx, 'handoff') };
  }

  private latest(projectId: string) {
    return this.prisma.sandboxRun.findFirst({ where: { projectId, kind: KIND }, orderBy: { createdAt: 'desc' } });
  }

  async get(userId: string, projectId: string) {
    const { ctx, stage } = await this.context(userId, projectId, 'read');
    const run = await this.latest(projectId);
    const canWrite = this.core.canWrite(ctx, 'handoff');
    const runs = stage.currentVersionId ? await this.prisma.sandboxRun.count({ where: { projectId, kind: KIND, sourceVersionId: stage.currentVersionId } }) : 0;
    return {
      data: {
        run: this.view(run, stage.currentVersionId),
        configured: Boolean(this.runner.sandbox()),
        canRun: canWrite && Boolean(stage.currentVersionId) && runs < STARTER_RUNS_PER_VERSION && !(run && ['queued', 'running'].includes(run.status)),
        runsLeft: Math.max(0, STARTER_RUNS_PER_VERSION - runs),
      },
    };
  }

  /** Builds the starter code from the inputs the current package was built from, and queues its tests. */
  async start(userId: string, projectId: string) {
    const { ctx, stage } = await this.context(userId, projectId, 'write');
    if (!stage.currentVersionId) throw new ConflictException('HANDOFF_NOT_BUILT');
    if (!inputsSatisfied(ctx.route, ctx.dep, 'handoff')) throw new ConflictException('STAGE_INPUTS_NOT_ACCEPTED');
    const latest = await this.latest(projectId);
    if (latest && ['queued', 'running'].includes(latest.status)) throw new ConflictException('STARTER_CHECK_RUNNING');
    const runs = await this.prisma.sandboxRun.count({ where: { projectId, kind: KIND, sourceVersionId: stage.currentVersionId } });
    if (runs >= STARTER_RUNS_PER_VERSION) throw new ForbiddenException('STARTER_CHECK_LIMIT');
    const inputs = await this.core.acceptedInputs(ctx, 'handoff');
    const code = buildStarterCode({ brief: (inputs.goal?.content as Brief | undefined) ?? null, features: inputs.features!.content as AppFeatures, plan: inputs.techplan!.content as TechPlan, locale: ctx.project.locale });
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.sandboxRun.create({ data: { projectId, kind: KIND, sourceVersionId: stage.currentVersionId!, files: code.files as never, filesDigest: digestOf(code.files), requestedByUserId: userId } });
      await this.core.event(tx, projectId, userId, 'starter_check_requested', 'handoff', { runId: run.id, files: code.files.length, collections: code.collections.length });
    });
    if (process.env.SANDBOX_WORKER !== 'external') this.runner.kick();
    return this.get(userId, projectId);
  }

  /** Files of the latest starter code, for the archive download. */
  async files(userId: string, projectId: string) {
    await this.context(userId, projectId, 'read');
    const run = await this.latest(projectId);
    if (!run) throw new NotFoundException('STARTER_NOT_BUILT');
    return { data: { status: run.status, files: run.files as unknown as StarterFile[] } };
  }
}
