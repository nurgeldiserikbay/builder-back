import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { GitProviderError, parseRepoUrl } from '../choices/git-providers.js';
import { acceptRoles, isUuid, JourneyCore } from '../journey/journey-core.js';
import { allowLocalRepos, AnalysisRunner } from './analysis-runner.js';
import { ANALYSIS_PROFILE, type AnalysisReport } from './code-analysis.js';
import { reportMarkdown, reportView, sourceKindLabels } from './report-view.js';

export const ANALYSIS_RUN_LIMITS = { active: 2, perDay: 20, list: 30 };
const refPattern = /^[A-Za-z0-9._/-]{1,200}$/;

const statusLabels: Record<string, string> = { queued: 'В очереди', running: 'Идёт разбор', succeeded: 'Готово', partial: 'Готово частично', failed: 'Не получилось', cancelled: 'Отменено' };
const errorLabels: Record<string, string> = {
  SOURCE_FILE_GONE: 'Архив удалили до начала разбора.',
  ZIP_INVALID: 'Файл не похож на ZIP-архив или повреждён.',
  ZIP64_NOT_SUPPORTED: 'Архив в формате ZIP64 пока не поддерживается. Сожмите проект обычным ZIP без папок с зависимостями.',
  ZIP_MULTI_DISK: 'Многотомные архивы не поддерживаются.',
  ZIP_TOO_MANY_ENTRIES: 'В архиве больше 5000 файлов. Уберите node_modules, vendor и результаты сборки.',
  ZIP_TOO_LARGE_UNPACKED: 'В распакованном виде архив больше 500 МБ.',
  ARCHIVE_TOO_LARGE: 'Архив репозитория больше 40 МБ.',
  ARCHIVE_DOWNLOAD_FAILED: 'Не удалось скачать архив репозитория.',
  ARCHIVE_REDIRECT_REFUSED: 'Сервис репозиториев отправил на неожиданный адрес; скачивание остановлено.',
  REPO_PROVIDER_UNAVAILABLE: 'Сервис репозиториев не ответил. Попробуйте позже.',
  REPO_TOKEN_INVALID: 'Доступ к репозиторию больше не действует. Подключите репозиторий заново.',
  REPO_ACCESS_DENIED: 'Нет доступа к репозиторию.',
  REPO_NOT_FOUND: 'Репозиторий или ветка не найдены. Закрытый репозиторий нужно сначала подключить.',
  REPO_NOT_CONNECTED: 'Репозиторий отключили до начала разбора.',
  REPO_RECONNECT_REQUIRED: 'Подключите репозиторий заново.',
  REPO_REF_INVALID: 'Неверное имя ветки.',
  ANALYSIS_FAILED: 'Разбор прервался из-за внутренней ошибки.',
};

/**
 * Read-only analysis of code: an uploaded ZIP, the connected repository or an open GitHub repository. Requesting a run
 * changes nothing in the project or the source; turning findings into work is a separate action.
 */
@Injectable()
export class AnalysisService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly runner: AnalysisRunner) {}

  /** Runs left queued (or stuck by a restart) are picked up when the API starts, unless a separate worker handles them. */
  onApplicationBootstrap(): void {
    if (process.env.ANALYSIS_WORKER !== 'external' && process.env.NODE_ENV !== 'test') this.runner.kick();
  }

  private async member(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    if (ctx.viewer.kind !== 'member') throw new NotFoundException('PROJECT_NOT_FOUND');
    return ctx;
  }

  private runView(run: { id: string; status: string; sourceKind: string; sourceLabel: string; sourceRef: string | null; sourceSha256: string | null; errorCode: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; requestedByUserId: string }, people: Map<string, { name: string }>) {
    return {
      id: run.id, status: run.status, statusLabel: tr(statusLabels[run.status] ?? run.status), sourceKind: run.sourceKind, sourceKindLabel: tr(sourceKindLabels[run.sourceKind] ?? run.sourceKind),
      sourceLabel: run.sourceLabel, sourceRef: run.sourceRef, sourceSha256: run.sourceSha256, errorCode: run.errorCode, error: run.errorCode ? tr(errorLabels[run.errorCode] ?? 'Разбор не получился.') : null,
      createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, requestedBy: people.get(run.requestedByUserId)?.name ?? tr('Участник'),
    };
  }

  async list(userId: string, projectId: string) {
    const ctx = await this.member(userId, projectId);
    const readable = ctx.stages.filter((stage) => this.core.canRead(ctx, stage.stageKey)).map((stage) => stage.id);
    const [runs, files, repo, people] = await Promise.all([
      this.prisma.analysisRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: ANALYSIS_RUN_LIMITS.list, select: { id: true, status: true, sourceKind: true, sourceLabel: true, sourceRef: true, sourceSha256: true, errorCode: true, createdAt: true, startedAt: true, finishedAt: true, requestedByUserId: true } }),
      this.prisma.stageFile.findMany({ where: { projectId, kind: 'zip', stageId: { in: readable } }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, sizeBytes: true, createdAt: true, stage: { select: { stageKey: true } } } }),
      this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true, repoPath: true, defaultBranch: true } }),
      this.core.historyPeople(ctx, projectId, userId),
    ]);
    const canRun = ctx.role !== 'viewer';
    return {
      data: {
        runs: runs.map((run) => this.runView(run, people)),
        sources: {
          files: files.map((file) => ({ id: file.id, name: file.name, sizeBytes: file.sizeBytes, stageKey: file.stage.stageKey, createdAt: file.createdAt })),
          repository: repo ? { provider: repo.provider, repoPath: repo.repoPath, defaultBranch: repo.defaultBranch, canUse: canRun && acceptRoles.has(ctx.role) } : null,
          publicRepo: canRun,
        },
        canRun, profile: ANALYSIS_PROFILE,
      },
    };
  }

  async create(userId: string, projectId: string, input: { source: string; fileId: string | null; url: string | null; ref: string | null; idempotencyKey: string | null }) {
    const ctx = await this.core.load(userId, projectId, 'write');
    if (input.idempotencyKey) {
      const existing = await this.prisma.analysisRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } }, select: { id: true } });
      if (existing) return this.get(userId, projectId, existing.id);
    }
    if (input.ref !== null && (!refPattern.test(input.ref) || input.ref.includes('..'))) throw new BadRequestException('REPO_REF_INVALID');
    let data: { sourceKind: string; sourceFileId: string | null; sourceLabel: string; sourceRef: string | null };
    if (input.source === 'file') {
      if (!input.fileId || !isUuid(input.fileId)) throw new NotFoundException('FILE_NOT_FOUND');
      const file = await this.prisma.stageFile.findFirst({ where: { id: input.fileId, projectId }, select: { id: true, name: true, kind: true, sha256: true, stage: { select: { stageKey: true } } } });
      if (!file || !this.core.canRead(ctx, file.stage.stageKey)) throw new NotFoundException('FILE_NOT_FOUND');
      if (file.kind !== 'zip') throw new BadRequestException('ANALYSIS_NEEDS_ZIP');
      data = { sourceKind: 'stage_file', sourceFileId: file.id, sourceLabel: file.name, sourceRef: null };
    } else if (input.source === 'repository') {
      if (!acceptRoles.has(ctx.role)) throw new ForbiddenException('ANALYSIS_REPOSITORY_FORBIDDEN');
      const repo = await this.prisma.codeRepository.findUnique({ where: { projectId }, select: { repoPath: true, defaultBranch: true } });
      if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
      data = { sourceKind: 'repository', sourceFileId: null, sourceLabel: repo.repoPath, sourceRef: input.ref ?? repo.defaultBranch };
    } else if (input.source === 'public_repo') {
      if (!input.url) throw new BadRequestException('REPO_URL_INVALID');
      let parsed: { baseUrl: string; repoPath: string };
      try { parsed = parseRepoUrl('github', input.url, allowLocalRepos()); } catch (error) { throw new BadRequestException(error instanceof GitProviderError ? error.code : 'REPO_URL_INVALID'); }
      data = { sourceKind: 'public_repo', sourceFileId: null, sourceLabel: `${parsed.baseUrl}/${parsed.repoPath}`, sourceRef: input.ref };
    } else throw new BadRequestException('ANALYSIS_SOURCE_INVALID');

    const since = new Date(Date.now() - 24 * 3600_000);
    const [active, today] = await Promise.all([
      this.prisma.analysisRun.count({ where: { projectId, status: { in: ['queued', 'running'] } } }),
      this.prisma.analysisRun.count({ where: { projectId, createdAt: { gte: since } } }),
    ]);
    if (active >= ANALYSIS_RUN_LIMITS.active) throw new ConflictException('ANALYSIS_ALREADY_RUNNING');
    if (today >= ANALYSIS_RUN_LIMITS.perDay) throw new ConflictException('ANALYSIS_DAILY_LIMIT');
    const run = await this.prisma.$transaction(async (tx) => {
      const row = await tx.analysisRun.create({ data: { projectId, ...data, profile: ANALYSIS_PROFILE, idempotencyKey: input.idempotencyKey, requestedByUserId: userId }, select: { id: true } });
      await this.core.event(tx, projectId, userId, 'analysis_run_requested', null, { runId: row.id, source: data.sourceKind });
      return row;
    });
    if (process.env.ANALYSIS_WORKER !== 'external') this.runner.kick();
    return this.get(userId, projectId, run.id);
  }

  private async load(userId: string, projectId: string, runId: string) {
    const ctx = await this.member(userId, projectId);
    if (!isUuid(runId)) throw new NotFoundException('ANALYSIS_NOT_FOUND');
    const run = await this.prisma.analysisRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException('ANALYSIS_NOT_FOUND');
    return { ctx, run };
  }

  async get(userId: string, projectId: string, runId: string) {
    const { ctx, run } = await this.load(userId, projectId, runId);
    const people = await this.core.historyPeople(ctx, projectId, userId);
    return { data: { ...this.runView(run, people), report: run.report ? reportView(run.report as unknown as AnalysisReport) : null } };
  }

  async export(userId: string, projectId: string, runId: string, format: string) {
    if (format !== 'md' && format !== 'json') throw new BadRequestException('EXPORT_FORMAT_INVALID');
    const { ctx, run } = await this.load(userId, projectId, runId);
    if (!run.report) throw new ConflictException('ANALYSIS_NOT_READY');
    const report = run.report as unknown as AnalysisReport;
    await this.core.event(this.prisma, projectId, userId, 'analysis_report_exported', null, { runId: run.id, format });
    const base = `analysis-${run.createdAt.toISOString().slice(0, 10)}-${run.id.slice(0, 8)}`;
    if (format === 'json') return { name: `${base}.json`, mime: 'application/json; charset=utf-8', body: JSON.stringify({ runId: run.id, createdAt: run.createdAt, finishedAt: run.finishedAt, ...report }, null, 2) };
    return { name: `${base}.md`, mime: 'text/markdown; charset=utf-8', body: reportMarkdown(ctx.project.name, run, report) };
  }
}
