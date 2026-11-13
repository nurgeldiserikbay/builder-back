import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { decryptToken, tokenKey } from '../security/token-crypto.js';
import { analyzeArchive } from './code-analysis.js';
import { ArchiveFetchError, fetchGithubArchive, fetchGitlabArchive } from './repo-archive.js';
import { ZipError } from './zip-reader.js';
import { GitProviderError, parseRepoUrl } from '../choices/git-providers.js';

type Fetch = typeof fetch;
const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;

export const allowLocalRepos = (env: NodeJS.ProcessEnv = process.env) => env.CODE_HOSTING_ALLOW_LOCAL === 'true' && env.NODE_ENV !== 'production';

export function githubApiFor(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return (baseUrl === 'https://github.com' ? (env.GITHUB_API_URL ?? 'https://api.github.com') : `${baseUrl}/api/v3`).replace(/\/$/, '');
}

/**
 * Takes queued analysis runs one at a time and writes their reports. Runs in the worker process; the API also starts it
 * right after a run is requested unless ANALYSIS_WORKER=external. Claiming is a conditional update, so two processes
 * never work on the same run. Nothing from the archive is executed or sent to an AI provider.
 */
@Injectable()
export class AnalysisRunner {
  private readonly logger = new Logger(AnalysisRunner.name);
  private busy = false;
  fetchImpl: Fetch = fetch;

  constructor(private readonly prisma: PrismaService) {}

  /** Starts draining the queue in the background of this process if it is not already doing so. */
  kick(): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try { while (await this.processNext()); } catch { this.logger.error('Analysis queue failed'); } finally { this.busy = false; }
    })();
  }

  /** The worker's loop: poll the queue until the process is asked to stop. */
  async loop(stopping: () => boolean): Promise<void> {
    this.logger.log('Analysis worker started');
    while (!stopping()) {
      try { if (!(await this.processNext())) await new Promise((resolve) => setTimeout(resolve, 2000)); } catch { await new Promise((resolve) => setTimeout(resolve, 5000)); }
    }
  }

  async claim(): Promise<string | null> {
    const stale = new Date(Date.now() - STALE_MS);
    const candidate = await this.prisma.analysisRun.findFirst({
      where: { OR: [{ status: 'queued' }, { status: 'running', startedAt: { lt: stale }, attemptCount: { lt: MAX_ATTEMPTS } }] },
      orderBy: { createdAt: 'asc' }, select: { id: true, status: true, startedAt: true },
    });
    if (!candidate) return null;
    const claimed = await this.prisma.analysisRun.updateMany({
      where: { id: candidate.id, status: candidate.status, startedAt: candidate.startedAt },
      data: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
    });
    return claimed.count === 1 ? candidate.id : null;
  }

  /** One run; false when the queue is empty. */
  async processNext(): Promise<boolean> {
    const id = await this.claim();
    if (!id) return false;
    await this.process(id);
    return true;
  }

  private async source(run: { projectId: string; sourceKind: string; sourceFileId: string | null; sourceLabel: string; sourceRef: string | null }): Promise<Buffer> {
    if (run.sourceKind === 'stage_file') {
      const file = run.sourceFileId ? await this.prisma.stageFile.findFirst({ where: { id: run.sourceFileId, projectId: run.projectId, kind: 'zip' }, select: { data: true } }) : null;
      if (!file) throw new ArchiveFetchError('SOURCE_FILE_GONE');
      return Buffer.from(file.data);
    }
    if (run.sourceKind === 'public_repo') {
      const { baseUrl, repoPath } = parseRepoUrl('github', run.sourceLabel, allowLocalRepos());
      return fetchGithubArchive(githubApiFor(baseUrl), repoPath, run.sourceRef ?? '', null, this.fetchImpl);
    }
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId: run.projectId } });
    if (!repo) throw new ArchiveFetchError('REPO_NOT_CONNECTED');
    const key = tokenKey();
    const token = key ? decryptToken(repo.tokenEncrypted, key) : null;
    if (!token) throw new ArchiveFetchError('REPO_RECONNECT_REQUIRED');
    const ref = run.sourceRef ?? repo.defaultBranch;
    return repo.provider === 'github'
      ? fetchGithubArchive(githubApiFor(repo.baseUrl), repo.repoPath, ref, token, this.fetchImpl)
      : fetchGitlabArchive(repo.baseUrl, repo.repoPath, ref, token, this.fetchImpl);
  }

  async process(id: string): Promise<void> {
    const run = await this.prisma.analysisRun.findUnique({ where: { id }, select: { id: true, projectId: true, status: true, sourceKind: true, sourceFileId: true, sourceLabel: true, sourceRef: true } });
    if (!run || run.status !== 'running') return;
    try {
      const bytes = await this.source(run);
      const report = analyzeArchive(bytes, { kind: run.sourceKind, label: run.sourceLabel, revision: run.sourceRef });
      await this.prisma.analysisRun.updateMany({
        where: { id, status: 'running' },
        data: { status: report.status, report: report as never, sourceSha256: report.source.sha256, finishedAt: new Date(), errorCode: null },
      });
    } catch (error) {
      const code = error instanceof ArchiveFetchError || error instanceof ZipError || error instanceof GitProviderError ? error.code : 'ANALYSIS_FAILED';
      if (code === 'ANALYSIS_FAILED') this.logger.error('Analysis run failed unexpectedly');
      await this.prisma.analysisRun.updateMany({ where: { id, status: 'running' }, data: { status: 'failed', errorCode: code, finishedAt: new Date() } });
    }
  }
}
