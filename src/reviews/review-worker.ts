import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../database/prisma.service.js';
import { discoverSameOriginPages } from './same-origin-discovery.js';

interface DiscoveryPayload {
  targetUrl?: unknown;
  hostname?: unknown;
  resolvedAddresses?: unknown;
}

@Injectable()
export class ReviewWorker implements OnModuleDestroy {
  private readonly logger = new Logger(ReviewWorker.name);
  private stopping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    this.logger.log('Review discovery worker started');
    while (!this.stopping) {
      try {
        const id = await this.claimNextJob();
        if (id) await this.processJob(id);
        else await delay(1200);
      } catch {
        this.logger.error('Worker loop failed; retrying after a short delay');
        await delay(2500);
      }
    }
  }

  private async claimNextJob(): Promise<string | null> {
    const candidate = await this.prisma.reviewJob.findFirst({
      where: { status: 'queued', jobType: 'discover_pages' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.reviewJob.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: {
        status: 'running',
        startedAt: new Date(),
        attemptCount: { increment: 1 },
        progressPercent: 1,
      },
    });
    return claimed.count === 1 ? candidate.id : null;
  }

  private async processJob(jobId: string): Promise<void> {
    const job = await this.prisma.reviewJob.findUnique({
      where: { id: jobId },
      select: { id: true, reviewRunId: true, result: true },
    });
    if (!job) return;

    const payload = (job.result && typeof job.result === 'object' && !Array.isArray(job.result)
      ? job.result
      : {}) as DiscoveryPayload;
    if (typeof payload.targetUrl !== 'string') {
      await this.fail(job.id, job.reviewRunId, 'DISCOVERY_TARGET_MISSING');
      return;
    }

    await this.prisma.reviewRun.update({
      where: { id: job.reviewRunId },
      data: { status: 'discovering', startedAt: new Date() },
    });

    try {
      const pages = await discoverSameOriginPages(payload.targetUrl, { maxPages: 30, maxDepth: 3 });
      if (pages.length > 0) {
        await this.prisma.reviewPage.createMany({
          data: pages.map((page) => ({
            reviewRunId: job.reviewRunId,
            route: page.url,
            title: page.title,
            discoveryDepth: page.depth,
            status: 'discovered' as const,
          })),
          skipDuplicates: true,
        });
      }

      if (pages.length === 0) {
        await this.fail(job.id, job.reviewRunId, 'NO_PAGES_DISCOVERED', payload);
        return;
      }

      await this.prisma.$transaction([
        this.prisma.reviewJob.update({
          where: { id: job.id },
          data: {
            status: 'succeeded',
            progressPercent: 100,
            finishedAt: new Date(),
            safeErrorCode: null,
            result: {
              targetUrl: payload.targetUrl,
              hostname: payload.hostname ?? null,
              resolvedAddresses: payload.resolvedAddresses ?? [],
              discoveredPageCount: pages.length,
            },
          },
        }),
        this.prisma.reviewRun.update({
          where: { id: job.reviewRunId },
          data: { status: 'ready', finishedAt: new Date() },
        }),
      ]);
    } catch {
      await this.fail(job.id, job.reviewRunId, 'DISCOVERY_FAILED', payload);
    }
  }

  private async fail(jobId: string, reviewRunId: string, safeErrorCode: string, payload: DiscoveryPayload = {}): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.reviewJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          safeErrorCode,
          progressPercent: 100,
          finishedAt: new Date(),
          result: {
            targetUrl: typeof payload.targetUrl === 'string' ? payload.targetUrl : null,
            hostname: typeof payload.hostname === 'string' ? payload.hostname : null,
            resolvedAddresses: Array.isArray(payload.resolvedAddresses) ? payload.resolvedAddresses : [],
          },
        },
      }),
      this.prisma.reviewRun.update({
        where: { id: reviewRunId },
        data: { status: 'failed', finishedAt: new Date() },
      }),
    ]);
    this.logger.warn('Discovery job ' + jobId + ' finished with ' + safeErrorCode);
  }
}
