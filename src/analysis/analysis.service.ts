import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { GitProviderError, parseRepoUrl } from '../choices/git-providers.js';
import { acceptRoles, isUuid, JourneyCore, writeRoles } from '../journey/journey-core.js';
import { allowLocalRepos, AnalysisRunner } from './analysis-runner.js';
import { ANALYSIS_PROFILE, type AnalysisReport } from './code-analysis.js';
import { reportMarkdown, reportView, sourceKindLabels } from './report-view.js';
import { artifactText, matchRequirements } from './requirements-match.js';
import { CommentsService } from '../journey/comments.service.js';
import { stageDefinitions, type StageKey } from '../journey/catalog.js';

/** Archives get the code analysis; PDF, Word and text get the document check. */
export const ANALYSABLE_KINDS = ['zip', 'pdf', 'docx', 'text'] as const;
/** Where a finding usually belongs, first stage of the route that matches. */
const sectionStages: Record<string, string[]> = {
  goal: ['goal'], audience: ['goal'], features: ['features', 'process', 'goal'], pages: ['sitemap', 'screens', 'content'], content: ['content'], design: ['design'],
  integrations: ['process', 'techplan'], deadline: ['goal'], budget: ['goal'], acceptance: ['features', 'goal'],
};
export function suggestStage(finding: { code: string; params?: Record<string, string | number> }, route: string[]): string | null {
  const wanted = finding.code === 'DOC_SECTION_MISSING' ? sectionStages[String(finding.params?.section)] ?? ['goal']
    : finding.code.startsWith('DOC_') ? ['goal']
      : ['build', 'handoff', 'techplan'];
  return wanted.find((key) => route.includes(key)) ?? route[0] ?? null;
}

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
  DOCUMENT_UNREADABLE: 'Документ не удалось прочитать: он повреждён или защищён паролем.',
  DOCUMENT_TOO_LARGE: 'Документ слишком большой для разбора (больше 200 страниц).',
  ANALYSIS_FILE_NOT_SUPPORTED: 'Такой файл не разбирается: подойдут ZIP, PDF, Word и текст.',
};

/**
 * Read-only analysis of code: an uploaded ZIP, the connected repository or an open GitHub repository. Requesting a run
 * changes nothing in the project or the source; turning findings into work is a separate action.
 */
@Injectable()
export class AnalysisService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore, private readonly runner: AnalysisRunner, private readonly comments: CommentsService) {}

  /** Runs left queued (or stuck by a restart) are picked up when the API starts, unless a separate worker handles them. */
  onApplicationBootstrap(): void {
    if (process.env.ANALYSIS_WORKER !== 'external' && process.env.NODE_ENV !== 'test') this.runner.kick();
  }

  /**
   * Project members only (not specialists). Works for projects without a route too — a project started as «Только анализ»
   * has no stages. Writing (starting a run, uploading a source) needs owner, manager or contributor in an open project.
   */
  private async member(userId: string, projectId: string, write = false) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: { id: true, name: true, status: true, projectType: true, startMode: true, members: { where: { userId, status: 'active' }, select: { role: true } } },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const role = project.members[0]!.role;
    const canWrite = writeRoles.has(role) && ['draft', 'active', 'live'].includes(project.status);
    if (write && !writeRoles.has(role)) throw new ForbiddenException('STAGE_WRITE_FORBIDDEN');
    if (write && !canWrite) throw new ConflictException('PROJECT_NOT_ACTIVE');
    return { project, role, canWrite };
  }

  private async people(ids: string[]): Promise<Map<string, { name: string }>> {
    const rows = ids.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(rows.map((row) => [row.id, { name: row.name || row.email.split('@')[0] || tr('Участник') }]));
  }

  private runView(run: { id: string; status: string; sourceKind: string; sourceLabel: string; sourceRef: string | null; sourceSha256: string | null; errorCode: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; requestedByUserId: string }, people: Map<string, { name: string }>) {
    return {
      id: run.id, status: run.status, statusLabel: tr(statusLabels[run.status] ?? run.status), sourceKind: run.sourceKind, sourceKindLabel: tr(sourceKindLabels[run.sourceKind] ?? run.sourceKind),
      sourceLabel: run.sourceLabel, sourceRef: run.sourceRef, sourceSha256: run.sourceSha256, errorCode: run.errorCode, error: run.errorCode ? tr(errorLabels[run.errorCode] ?? 'Разбор не получился.') : null,
      createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, requestedBy: people.get(run.requestedByUserId)?.name ?? tr('Участник'),
    };
  }

  async list(userId: string, projectId: string) {
    const { project, role, canWrite } = await this.member(userId, projectId);
    const [runs, files, repo] = await Promise.all([
      this.prisma.analysisRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: ANALYSIS_RUN_LIMITS.list, select: { id: true, status: true, sourceKind: true, sourceLabel: true, sourceRef: true, sourceSha256: true, errorCode: true, createdAt: true, startedAt: true, finishedAt: true, requestedByUserId: true } }),
      this.prisma.stageFile.findMany({ where: { projectId, kind: { in: [...ANALYSABLE_KINDS] } }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, kind: true, sizeBytes: true, createdAt: true, createdByUserId: true, stage: { select: { stageKey: true } } } }),
      this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true, repoPath: true, defaultBranch: true } }),
    ]);
    const people = await this.people(runs.map((run) => run.requestedByUserId));
    return {
      data: {
        project: { name: project.name, analysisOnly: !project.projectType, startMode: project.startMode },
        runs: runs.map((run) => this.runView(run, people)),
        sources: {
          files: files.map((file) => ({ id: file.id, name: file.name, kind: file.kind, sizeBytes: file.sizeBytes, stageKey: file.stage?.stageKey ?? null, createdAt: file.createdAt, canDelete: canWrite && !file.stage && (acceptRoles.has(role) || file.createdByUserId === userId) })),
          repository: repo ? { provider: repo.provider, repoPath: repo.repoPath, defaultBranch: repo.defaultBranch, canUse: canWrite && acceptRoles.has(role) } : null,
          publicRepo: canWrite,
          canUpload: canWrite,
        },
        canRun: canWrite, profile: ANALYSIS_PROFILE,
        // Where findings can go: stages of the route (none for «Только анализ»), and whether the owner may add a route.
        stages: project.projectType && canWrite ? (await this.prisma.projectStage.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { stageKey: true } })).filter((row) => row.stageKey in stageDefinitions).map((row) => ({ key: row.stageKey, title: tr(stageDefinitions[row.stageKey as StageKey].title) })) : [],
        canAddRoute: !project.projectType && role === 'owner' && canWrite,
      },
    };
  }

  async create(userId: string, projectId: string, input: { source: string; fileId: string | null; url: string | null; ref: string | null; idempotencyKey: string | null }) {
    const { role } = await this.member(userId, projectId, true);
    if (input.idempotencyKey) {
      const existing = await this.prisma.analysisRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } }, select: { id: true } });
      if (existing) return this.get(userId, projectId, existing.id);
    }
    if (input.ref !== null && (!refPattern.test(input.ref) || input.ref.includes('..'))) throw new BadRequestException('REPO_REF_INVALID');
    let data: { sourceKind: string; sourceFileId: string | null; sourceLabel: string; sourceRef: string | null };
    if (input.source === 'file') {
      if (!input.fileId || !isUuid(input.fileId)) throw new NotFoundException('FILE_NOT_FOUND');
      const file = await this.prisma.stageFile.findFirst({ where: { id: input.fileId, projectId }, select: { id: true, name: true, kind: true } });
      if (!file) throw new NotFoundException('FILE_NOT_FOUND');
      if (!ANALYSABLE_KINDS.includes(file.kind as never)) throw new BadRequestException('ANALYSIS_FILE_NOT_SUPPORTED');
      data = { sourceKind: 'stage_file', sourceFileId: file.id, sourceLabel: file.name, sourceRef: null };
    } else if (input.source === 'repository') {
      if (!acceptRoles.has(role)) throw new ForbiddenException('ANALYSIS_REPOSITORY_FORBIDDEN');
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
    const people = await this.people([run.requestedByUserId]);
    const route = ctx.project.projectType ? (await this.prisma.projectStage.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { stageKey: true } })).map((row) => row.stageKey) : [];
    const report = run.report as unknown as AnalysisReport | null;
    const view = report ? reportView(report) : null;
    return { data: { ...this.runView(run, people), report: view ? { ...view, findings: view.findings.map((finding, index) => ({ ...finding, suggestedStageKey: route.length ? suggestStage(report!.findings[index]!, route) : null })) } : null } };
  }

  /**
   * A finding becomes a remark on a stage of the project: the person who picks it decides where the work belongs.
   * The remark carries the explanation, what to do and where, and names the report; it follows the usual remark rules
   * (who may write, notifications). The report itself does not change.
   */
  async toRemark(userId: string, projectId: string, runId: string, findingId: string, stageKey: string) {
    const { ctx, run } = await this.load(userId, projectId, runId);
    if (!ctx.project.projectType) throw new ConflictException('PROJECT_HAS_NO_ROUTE');
    if (!run.report) throw new ConflictException('ANALYSIS_NOT_READY');
    const view = reportView(run.report as unknown as AnalysisReport);
    const finding = view.findings.find((item) => item.id === findingId);
    if (!finding) throw new NotFoundException('FINDING_NOT_FOUND');
    if (!(stageKey in stageDefinitions)) throw new BadRequestException('INVALID_STAGE_KEY');
    const where = finding.evidence.slice(0, 5).map((item) => (view.type === 'document' ? (item.line ? tr('абзац {0}', [item.line]) : item.path) : `${item.path}${item.line ? `:${item.line}` : ''}`)).join(', ');
    const text = [
      `${finding.severityLabel}: ${finding.title}`, finding.explanation, `${tr('Что сделать')}: ${finding.remediation}`, `${tr('Где')}: ${where}`,
      tr('Из разбора «{0}» от {1}.', [run.sourceLabel, run.createdAt.toISOString().slice(0, 10)]),
    ].join('\n').slice(0, 2000);
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey }, select: { id: true } });
    if (!stage) throw new NotFoundException('STAGE_NOT_FOUND');
    const sourceOnStage = run.sourceFileId ? await this.prisma.stageFile.count({ where: { id: run.sourceFileId, stageId: stage.id } }) : 0;
    const result = await this.comments.add(userId, projectId, stageKey, { text, targetKey: null, blocking: false, parentId: null, fileIds: sourceOnStage ? [run.sourceFileId!] : [] });
    await this.core.event(this.prisma, projectId, userId, 'analysis_finding_to_remark', stageKey, { runId: run.id, findingId, commentId: result.data.createdId });
    return { data: { commentId: result.data.createdId, stageKey, stageTitle: tr(stageDefinitions[stageKey as StageKey].title) } };
  }

  /**
   * The brief of a document report against the accepted results of the project's stages, by words. Computed on
   * request, so it follows the stages as they are accepted; the report itself does not change.
   */
  async compare(userId: string, projectId: string, runId: string) {
    const { ctx, run } = await this.load(userId, projectId, runId);
    if (!ctx.project.projectType) throw new ConflictException('PROJECT_HAS_NO_ROUTE');
    const report = run.report as unknown as AnalysisReport | null;
    if (!report) throw new ConflictException('ANALYSIS_NOT_READY');
    if (report.type !== 'document') throw new ConflictException('COMPARE_NOT_A_DOCUMENT');
    // Reports made before requirements were kept: the document is analysed again rather than guessed from.
    if (!report.document?.requirements) throw new ConflictException('COMPARE_ANALYZE_AGAIN');
    const stages = await this.prisma.projectStage.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { stageKey: true, status: true, approvedVersionId: true } });
    const accepted = stages.filter((stage) => stage.approvedVersionId);
    const versions = accepted.length ? await this.prisma.stageArtifactVersion.findMany({ where: { id: { in: accepted.map((stage) => stage.approvedVersionId!) } }, select: { id: true, content: true } }) : [];
    const title = (key: string) => tr(stageDefinitions[key as StageKey]?.title ?? key);
    const texts = accepted.map((stage) => ({ key: stage.stageKey, title: title(stage.stageKey), text: artifactText(versions.find((version) => version.id === stage.approvedVersionId)?.content) }));
    const items = matchRequirements(report.document.requirements, texts);
    const count = (status: string) => items.filter((item) => item.status === status).length;
    return {
      data: {
        runId: run.id, sourceLabel: run.sourceLabel, items,
        totals: { requirements: items.length, found: count('found'), partial: count('partial'), missing: count('missing') },
        comparedStages: texts.map((stage) => ({ key: stage.key, title: stage.title })),
        notAccepted: stages.filter((stage) => !stage.approvedVersionId).map((stage) => ({ key: stage.stageKey, title: title(stage.stageKey) })),
        note: tr('Сверка по словам: «найдено» значит, что слова требования есть в принятом этапе, а не что результат его выполняет. «Не найдено» — повод проверить, а не доказательство, что требования нет. Учитываются только принятые этапы.'),
      },
    };
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
