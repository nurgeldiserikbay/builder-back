import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { compareDesignToCapture } from './visual-diff.js';
import { captureReviewPage } from './page-capture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
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
      where: { status: 'queued', jobType: { in: ['discover_pages', 'capture_page'] } },
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
      select: { id: true, reviewRunId: true, result: true, jobType: true },
    });
    if (!job) return;
    if (job.jobType === 'capture_page') {
      await this.processCapture(job.id, job.reviewRunId, job.result);
      return;
    }

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

  private async processCapture(jobId: string, reviewRunId: string, rawResult: unknown): Promise<void> {
    const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult) ? rawResult as Record<string, unknown> : {};
    const captureId = typeof result.captureId === 'string' ? result.captureId : '';
    const targetUrl = typeof result.targetUrl === 'string' ? result.targetUrl : '';
    const viewport = result.viewport && typeof result.viewport === 'object' && !Array.isArray(result.viewport) ? result.viewport as Record<string, unknown> : {};
    const width = viewport.width;
    const height = viewport.height;
    const deviceScale = viewport.deviceScale;
    const bucket = process.env.DESIGN_ASSETS_BUCKET;
    if (!captureId || !targetUrl || typeof width !== 'number' || typeof height !== 'number' || typeof deviceScale !== 'number') {
      await this.failCapture(jobId, captureId, 'CAPTURE_JOB_INVALID');
      return;
    }
    if (!bucket) {
      await this.failCapture(jobId, captureId, 'CAPTURE_STORAGE_NOT_CONFIGURED');
      return;
    }
    const endpoint = process.env.DESIGN_ASSETS_ENDPOINT;
    const storage = new S3Client({
      region: process.env.DESIGN_ASSETS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.DESIGN_ASSETS_PATH_STYLE === 'true',
      ...(process.env.DESIGN_ASSETS_ACCESS_KEY && process.env.DESIGN_ASSETS_SECRET_KEY ? {
        credentials: { accessKeyId: process.env.DESIGN_ASSETS_ACCESS_KEY, secretAccessKey: process.env.DESIGN_ASSETS_SECRET_KEY },
      } : {}),
    });
    let storageKey: string | null = null;
    let diffStorageKey: string | null = null;
    let objectWritten = false;
    let diffObjectWritten = false;
    try {
      const screenshot = await captureReviewPage({
        targetUrl,
        viewport: { width, height, deviceScale },
      });
      storageKey = `${reviewRunId}/captures/${captureId}.png`;
      await storage.send(new PutObjectCommand({
        Bucket: bucket, Key: storageKey, Body: screenshot.bytes, ContentType: 'image/png', Metadata: { captureid: captureId, sha256: screenshot.sha256 },
      }));
      objectWritten = true;

      let visualDiff: Record<string, unknown> = { status: 'failed', safeErrorCode: 'VISUAL_DIFF_FAILED' };
      try {
        const capture = await this.prisma.reviewCapture.findUnique({
          where: { id: captureId },
          select: { designSource: { select: { storageKey: true, assetStatus: true } } },
        });
        const designKey = capture?.designSource?.assetStatus === 'verified' ? capture.designSource.storageKey : null;
        if (!designKey) throw new Error('VISUAL_DIFF_DESIGN_NOT_FOUND');
        const designObject = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: designKey }));
        if (!designObject.Body) throw new Error('VISUAL_DIFF_DESIGN_READ_FAILED');
        const parts: Buffer[] = [];
        let total = 0;
        for await (const chunk of designObject.Body as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > 20 * 1024 * 1024) throw new Error('VISUAL_DIFF_DESIGN_TOO_LARGE');
          parts.push(bytes);
        }
        const diff = await compareDesignToCapture(screenshot.bytes, Buffer.concat(parts));
        diffStorageKey = `${reviewRunId}/captures/${captureId}-diff.png`;
        await storage.send(new PutObjectCommand({
          Bucket: bucket, Key: diffStorageKey, Body: diff.overlay, ContentType: 'image/png',
          Metadata: { captureid: captureId, kind: 'visual-diff' },
        }));
        diffObjectWritten = true;
        visualDiff = {
          status: 'ready', diffStorageKey, changedPercent: diff.changedPercent, changedPixels: diff.changedPixels,
          totalPixels: diff.totalPixels, width: diff.width, height: diff.height, threshold: diff.threshold, regions: diff.regions,
        };
      } catch (error) {
        const reason = error instanceof Error && /^VISUAL_DIFF_[A-Z_]+$/.test(error.message) ? error.message : 'VISUAL_DIFF_FAILED';
        visualDiff = { status: 'failed', safeErrorCode: reason };
        this.logger.warn('Visual diff for capture ' + captureId + ' finished with ' + reason);
      }

      await this.prisma.$transaction([
        this.prisma.reviewCapture.update({
          where: { id: captureId },
          data: { status: 'captured', assetStorageKey: storageKey, visualDiff: visualDiff as Prisma.InputJsonValue, qualityAudit: screenshot.audit as Prisma.InputJsonValue, sha256: screenshot.sha256, toolVersion: screenshot.toolVersion, capturedAt: new Date(), safeErrorCode: null },
        }),
        this.prisma.reviewJob.update({
          where: { id: jobId },
          data: { status: 'succeeded', progressPercent: 100, finishedAt: new Date(), safeErrorCode: null, result: { ...result, finalUrl: screenshot.finalUrl, screenshotSha256: screenshot.sha256 } as Prisma.InputJsonValue },
        }),
      ]);
    } catch (error) {
      if (objectWritten && storageKey) await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey })).catch(() => undefined);
      if (diffObjectWritten && diffStorageKey) await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: diffStorageKey })).catch(() => undefined);
      const message = error instanceof Error ? error.message : '';
      const code = /^CAPTURE_[A-Z_]+$/.test(message) ? message : 'CAPTURE_FAILED';
      await this.failCapture(jobId, captureId, code);
      this.logger.warn('Capture job ' + jobId + ' finished with ' + code);
    } finally {
      await storage.destroy();
    }
  }

  private async failCapture(jobId: string, captureId: string, safeErrorCode: string): Promise<void> {
    await this.prisma.$transaction([
      ...(captureId ? [this.prisma.reviewCapture.update({ where: { id: captureId }, data: { status: 'failed', safeErrorCode } })] : []),
      this.prisma.reviewJob.update({
        where: { id: jobId },
        data: { status: 'failed', progressPercent: 100, finishedAt: new Date(), safeErrorCode },
      }),
    ]);
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
