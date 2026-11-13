import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { tr } from '../i18n/i18n.js';
import type { SiteArtifact } from '../journey/artifacts.js';
import { isUuid, JourneyCore } from '../journey/journey-core.js';
import { BrowserCheckError, imageIds, runBrowserCheck, type BrowserCheckResult } from './browser-check.js';

const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
export const BROWSER_CHECK_RUNS_PER_VERSION = 5;

/** Queued browser checks, one at a time. Runs in the worker; in the API too unless BROWSER_CHECK_WORKER=external. */
@Injectable()
export class BrowserCheckRunner {
  private readonly logger = new Logger(BrowserCheckRunner.name);
  private busy = false;
  run = runBrowserCheck;

  constructor(private readonly prisma: PrismaService) {}

  kick(): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try { while (await this.processNext()); } catch { this.logger.error('Browser check queue failed'); } finally { this.busy = false; }
    })();
  }

  async loop(stopping: () => boolean): Promise<void> {
    this.logger.log('Browser check worker started');
    while (!stopping()) {
      try { if (!(await this.processNext())) await new Promise((resolve) => setTimeout(resolve, 3000)); } catch { await new Promise((resolve) => setTimeout(resolve, 5000)); }
    }
  }

  async claim(): Promise<string | null> {
    const stale = new Date(Date.now() - STALE_MS);
    const candidate = await this.prisma.browserCheck.findFirst({
      where: { OR: [{ status: 'queued' }, { status: 'running', startedAt: { lt: stale }, attemptCount: { lt: MAX_ATTEMPTS } }] },
      orderBy: { createdAt: 'asc' }, select: { id: true, status: true, startedAt: true },
    });
    if (!candidate) return null;
    const claimed = await this.prisma.browserCheck.updateMany({ where: { id: candidate.id, status: candidate.status, startedAt: candidate.startedAt }, data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } } });
    return claimed.count === 1 ? candidate.id : null;
  }

  async processNext(): Promise<boolean> {
    const id = await this.claim();
    if (!id) return false;
    await this.process(id);
    return true;
  }

  async process(id: string): Promise<void> {
    const check = await this.prisma.browserCheck.findUnique({ where: { id }, select: { id: true, projectId: true, versionId: true, status: true } });
    if (!check || check.status !== 'running') return;
    const finish = (data: { status: string; result?: BrowserCheckResult; errorCode?: string | null }) =>
      this.prisma.browserCheck.updateMany({ where: { id, status: 'running' }, data: { status: data.status, result: (data.result ?? undefined) as never, errorCode: data.errorCode ?? null, finishedAt: new Date() } });
    try {
      const version = await this.prisma.stageArtifactVersion.findFirst({ where: { id: check.versionId, projectId: check.projectId }, select: { content: true, project: { select: { locale: true } } } });
      const site = version?.content as unknown as SiteArtifact | undefined;
      if (!site?.html) { await finish({ status: 'failed', errorCode: 'BUILD_NOT_FOUND' }); return; }
      const pages = site.pages?.length ? site.pages.map((page) => ({ path: page.path, html: page.html })) : [{ path: '/', html: site.html }];
      const ids = imageIds(pages);
      const rows = ids.length ? await this.prisma.projectImage.findMany({ where: { projectId: check.projectId, id: { in: ids } }, select: { id: true, data: true } }) : [];
      const images = new Map(rows.map((row) => [row.id.toLowerCase(), Buffer.from(row.data)]));
      const result = await this.run({ pages, images, locale: version!.project.locale === 'en' ? 'en' : 'ru' });
      await finish({ status: 'succeeded', result });
    } catch (error) {
      const code = error instanceof BrowserCheckError ? error.code : 'BROWSER_CHECK_FAILED';
      if (code === 'BROWSER_CHECK_FAILED') this.logger.error('Browser check failed unexpectedly');
      // No browser on this server is not a failure of the site.
      await finish({ status: code === 'BROWSER_NOT_CONFIGURED' ? 'unavailable' : 'failed', errorCode: code });
    }
  }
}

const statusLabels: Record<string, string> = { queued: 'В очереди', running: 'Идёт проверка', succeeded: 'Готово', failed: 'Не получилось', unavailable: 'Недоступна' };
const errorLabels: Record<string, string> = {
  BROWSER_NOT_CONFIGURED: 'На этом сервере нет браузера для проверки. Её выполняет отдельный обработчик проверок, когда он запущен.',
  BROWSER_START_FAILED: 'Браузер для проверки не запустился. Попробуйте ещё раз позже.',
  PAGE_TIMEOUT: 'Страница проверялась слишком долго.',
  BUILD_NOT_FOUND: 'Сборка не найдена.',
  NO_REPORT: 'Браузер не вернул отчёт.',
  PAGE_CHECK_FAILED: 'Страницу не удалось проверить.',
  BROWSER_CHECK_FAILED: 'Проверка прервалась из-за внутренней ошибки.',
};
const categoryLabels: Record<string, string> = { performance: 'Скорость', accessibility: 'Доступность', 'best-practices': 'Надёжность', seo: 'Поисковики' };

/** Browser check of a build for the «Сборка» stage: status, scores and what to look at. Advisory, never blocks publishing. */
@Injectable()
export class BrowserChecksService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly runner: BrowserCheckRunner) {}

  onApplicationBootstrap(): void {
    if (process.env.BROWSER_CHECK_WORKER === 'external' || process.env.NODE_ENV === 'test') return;
    this.runner.kick();
    // New builds queue a check; pick them up without a separate worker.
    this.timer = setInterval(() => this.runner.kick(), 10_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private view(check: { id: string; versionId: string; status: string; result: unknown; errorCode: string | null; createdAt: Date; finishedAt: Date | null; runs: number } | null, canRerun: boolean) {
    // A build made before checks existed can be checked on request.
    if (!check) return { check: null, canRerun };
    const result = check.result as BrowserCheckResult | null;
    return {
      check: {
        id: check.id, versionId: check.versionId, status: check.status, statusLabel: tr(statusLabels[check.status] ?? check.status), createdAt: check.createdAt, finishedAt: check.finishedAt,
        error: check.errorCode ? tr(errorLabels[check.errorCode] ?? 'Проверка не получилась.') : null,
        result: result ? {
          ...result,
          pages: result.pages.map((page) => ({ ...page, error: page.error ? tr(errorLabels[page.error] ?? 'Страницу не удалось проверить.') : null, issues: page.issues.map((issue) => ({ ...issue, categoryLabel: tr(categoryLabels[issue.category] ?? issue.category) })) })),
        } : null,
        categories: Object.entries(categoryLabels).map(([key, label]) => ({ key, label: tr(label) })),
        note: tr('Измерено в лаборатории: Lighthouse в браузере Chromium на копии сайта без интернета, как на телефоне среднего уровня с медленной сетью. У настоящих посетителей цифры другие. Проверка подсказывает, а не запрещает публикацию.'),
      },
      canRerun: canRerun && check.runs < BROWSER_CHECK_RUNS_PER_VERSION && !['queued', 'running'].includes(check.status),
    };
  }

  private async target(userId: string, projectId: string, versionId: string | null, access: 'read' | 'write') {
    const ctx = await this.core.load(userId, projectId, access, 'build');
    const stage = this.core.stageOf(ctx, 'build');
    const id = versionId ?? stage.currentVersionId;
    if (!id || !isUuid(id)) return { ctx, id: null };
    const version = await this.prisma.stageArtifactVersion.findFirst({ where: { id, stageId: stage.id }, select: { id: true } });
    if (!version) throw new NotFoundException('VERSION_NOT_FOUND');
    return { ctx, id };
  }

  async get(userId: string, projectId: string, versionId: string | null) {
    const { ctx, id } = await this.target(userId, projectId, versionId, 'read');
    const check = id ? await this.prisma.browserCheck.findUnique({ where: { versionId: id } }) : null;
    return { data: this.view(check, Boolean(id) && this.core.canWrite(ctx, 'build')) };
  }

  /** Check the build again (or for the first time, for builds made before checks existed). */
  async rerun(userId: string, projectId: string, versionId: string | null) {
    const { id } = await this.target(userId, projectId, versionId, 'write');
    if (!id) throw new NotFoundException('VERSION_NOT_FOUND');
    const existing = await this.prisma.browserCheck.findUnique({ where: { versionId: id }, select: { status: true, runs: true } });
    if (existing && ['queued', 'running'].includes(existing.status)) throw new ConflictException('BROWSER_CHECK_RUNNING');
    if (existing && existing.runs >= BROWSER_CHECK_RUNS_PER_VERSION) throw new ForbiddenException('BROWSER_CHECK_LIMIT');
    await this.prisma.$transaction(async (tx) => {
      await tx.browserCheck.upsert({
        where: { versionId: id },
        create: { projectId, versionId: id, requestedByUserId: userId },
        update: { status: 'queued', result: Prisma.DbNull, errorCode: null, attemptCount: 0, startedAt: null, finishedAt: null, runs: { increment: 1 }, requestedByUserId: userId },
      });
      await this.core.event(tx, projectId, userId, 'browser_check_requested', 'build', { versionId: id });
    });
    if (process.env.BROWSER_CHECK_WORKER !== 'external') this.runner.kick();
    return this.get(userId, projectId, id);
  }

  /** Queues a check for a new build; called inside the build transaction. */
  static queue(tx: Pick<PrismaService, 'browserCheck'>, projectId: string, versionId: string, userId: string) {
    return tx.browserCheck.create({ data: { projectId, versionId, requestedByUserId: userId } });
  }
}
