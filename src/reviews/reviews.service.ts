import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from './url-target-policy.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReviewsCore } from './reviews-core.js';
import { ReviewDesignsService } from './review-designs.service.js';
import { ReviewFigmaService } from './review-figma.service.js';
import { ReviewCapturesService } from './review-captures.service.js';
import { ReviewChecksService } from './review-checks.service.js';
import { ReviewReportService } from './review-report.service.js';
import { reviewSelect } from './review-shared.js';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: ReviewsCore,
    private readonly designs: ReviewDesignsService,
    private readonly figma: ReviewFigmaService,
    private readonly captures: ReviewCapturesService,
    private readonly checks: ReviewChecksService,
    private readonly report: ReviewReportService,
  ) {}

  async create(userId: string, projectId: string, input: {
    title: string;
    mode: 'site_only' | 'site_and_design' | 'design_only';
    locale: 'en' | 'ru' | 'kk';
  }, idempotencyKey: string) {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true, status: true },
    });
    if (!membership || membership.status !== 'active') throw new NotFoundException('PROJECT_NOT_FOUND');
    if (membership.role === 'viewer') throw new ForbiddenException('REVIEW_CREATE_FORBIDDEN');

    const scope = `review:create:${projectId}`;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const now = new Date();
    const createOrReplay = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        const existingReview = await tx.reviewRun.findUnique({
          where: { id: previous.resourceId },
          select: reviewSelect,
        });
        if (existingReview) return existingReview;
      }
      if (previous) await tx.idempotencyRecord.delete({ where: { id: previous.id } });

      const defaultProfile = await tx.qualityProfile.findFirst({
        where: { isDefault: true },
        include: { versions: { where: { status: 'active' }, take: 1 } },
      });
      const activeProfileVersion = defaultProfile?.versions[0];
      const configuration = defaultProfile && activeProfileVersion ? JSON.parse(JSON.stringify({
        qualityProfile: {
          key: defaultProfile.key,
          name: defaultProfile.name,
          version: activeProfileVersion.version,
          policy: activeProfileVersion.policy,
        },
      })) : undefined;
      const review = await tx.reviewRun.create({
        data: {
          projectId, ownerUserId: userId, ...input,
          ...(configuration ? { configuration } : {}),
        },
        select: reviewSelect,
      });
      await tx.idempotencyRecord.create({
        data: {
          userId,
          scope,
          key: idempotencyKey,
          requestHash,
          resourceId: review.id,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      return review;
    });

    try {
      return { data: await createOrReplay() };
    } catch (error) {
      if (!this.core.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (!previous || previous.expiresAt <= new Date()) throw error;
      if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      const existingReview = await this.prisma.reviewRun.findUnique({
        where: { id: previous.resourceId },
        select: reviewSelect,
      });
      if (!existingReview) throw error;
      return { data: existingReview };
    }
  }

  async get(userId: string, reviewId: string) {
    if (!this.core.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: {
        id: reviewId,
        project: { members: { some: { userId, status: 'active' } } },
      },
      select: reviewSelect,
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    return { data: review };
  }



  async listPages(userId: string, reviewId: string) {
    if (!this.core.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active' } } } },
      select: { id: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');

    const pages = await this.prisma.reviewPage.findMany({
      where: { reviewRunId: review.id, status: { not: 'excluded' } },
      orderBy: [{ discoveryDepth: 'asc' }, { route: 'asc' }],
      take: 100,
      select: {
        id: true,
        route: true,
        title: true,
        status: true,
        mapping: { select: { designSourceId: true, viewportWidth: true, viewportHeight: true, deviceScale: true } },
        _count: { select: { findings: true } },
      },
    });
    return {
      data: pages.map((page) => ({
        id: page.id,
        route: page.route,
        label: (page.title ?? page.route).slice(0, 120),
        status: page.mapping ? 'mapped' : page.status === 'captured' ? 'captured' : page.status === 'failed' ? 'failed' : 'discovered',
        designAssetId: page.mapping?.designSourceId ?? null,
        viewport: {
          width: page.mapping?.viewportWidth ?? 1440,
          height: page.mapping?.viewportHeight ?? 900,
          deviceScale: page.mapping ? Number(page.mapping.deviceScale) : 1,
        },
        findingCount: page._count.findings,
      })),
    };
  }

  async registerUrl(userId: string, reviewId: string, rawUrl: string, idempotencyKey: string) {
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active', role: { not: 'viewer' } } } } },
      select: { id: true, mode: true },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');
    if (review.mode === 'design_only') throw new ConflictException('REVIEW_MODE_DOES_NOT_ACCEPT_SITE_URL');

    let target: Awaited<ReturnType<typeof resolveAndValidateReviewTarget>>;
    try {
      target = await resolveAndValidateReviewTarget(rawUrl);
    } catch (error) {
      if (error instanceof ReviewTargetPolicyError) {
        throw new UnprocessableEntityException({ code: error.code });
      }
      throw error;
    }

    const persist = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.reviewJob.findUnique({
        where: { reviewRunId_idempotencyKey: { reviewRunId: review.id, idempotencyKey } },
      });
      if (previous) {
        const stored = previous.result;
        const previousUrl = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
          ? (stored as Record<string, unknown>).targetUrl
          : undefined;
        if (previousUrl !== target.url) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        return previous;
      }

      await tx.reviewRun.update({
        where: { id: review.id },
        data: {
          baseOrigin: new URL(target.url).origin,
          sourceSnapshot: {
            validatedUrl: target.url,
            hostname: target.hostname,
            resolvedAddresses: target.resolvedAddresses,
            validatedAt: new Date().toISOString(),
          },
          status: 'queued',
        },
      });
      return tx.reviewJob.create({
        data: {
          reviewRunId: review.id,
          jobType: 'discover_pages',
          idempotencyKey,
          correlationId: randomUUID(),
          result: {
            targetUrl: target.url,
            hostname: target.hostname,
            resolvedAddresses: target.resolvedAddresses,
          },
        },
      });
    });

    try {
      const job = await persist();
      return { data: { jobId: job.id, status: job.status } };
    } catch (error) {
      if (!this.core.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.reviewJob.findUnique({
        where: { reviewRunId_idempotencyKey: { reviewRunId: review.id, idempotencyKey } },
      });
      if (!previous) throw error;
      const stored = previous.result;
      const previousUrl = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>).targetUrl
        : undefined;
      if (previousUrl !== target.url) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      return { data: { jobId: previous.id, status: previous.status } };
    }
  }

  // --- Delegated to the split services (the controller keeps calling ReviewsService) ---

  reserveDesignUpload(...args: Parameters<ReviewDesignsService['reserveDesignUpload']>) { return this.designs.reserveDesignUpload(...args); }
  completeDesignUpload(...args: Parameters<ReviewDesignsService['completeDesignUpload']>) { return this.designs.completeDesignUpload(...args); }
  getDesignAssetUrl(...args: Parameters<ReviewDesignsService['getDesignAssetUrl']>) { return this.designs.getDesignAssetUrl(...args); }
  savePageMapping(...args: Parameters<ReviewDesignsService['savePageMapping']>) { return this.designs.savePageMapping(...args); }
  startFigmaConnection(...args: Parameters<ReviewFigmaService['startFigmaConnection']>) { return this.figma.startFigmaConnection(...args); }
  completeFigmaConnection(...args: Parameters<ReviewFigmaService['completeFigmaConnection']>) { return this.figma.completeFigmaConnection(...args); }
  getFigmaConnectionStatus(...args: Parameters<ReviewFigmaService['getFigmaConnectionStatus']>) { return this.figma.getFigmaConnectionStatus(...args); }
  disconnectFigma(...args: Parameters<ReviewFigmaService['disconnectFigma']>) { return this.figma.disconnectFigma(...args); }
  importFigmaFrame(...args: Parameters<ReviewFigmaService['importFigmaFrame']>) { return this.figma.importFigmaFrame(...args); }
  queueCapture(...args: Parameters<ReviewCapturesService['queueCapture']>) { return this.captures.queueCapture(...args); }
  getCapture(...args: Parameters<ReviewCapturesService['getCapture']>) { return this.captures.getCapture(...args); }
  analyzeCaptureWithAi(...args: Parameters<ReviewCapturesService['analyzeCaptureWithAi']>) { return this.captures.analyzeCaptureWithAi(...args); }
  createFinding(...args: Parameters<ReviewChecksService['createFinding']>) { return this.checks.createFinding(...args); }
  createRequirement(...args: Parameters<ReviewChecksService['createRequirement']>) { return this.checks.createRequirement(...args); }
  listRequirements(...args: Parameters<ReviewChecksService['listRequirements']>) { return this.checks.listRequirements(...args); }
  updateRequirement(...args: Parameters<ReviewChecksService['updateRequirement']>) { return this.checks.updateRequirement(...args); }
  updateFindingStatus(...args: Parameters<ReviewChecksService['updateFindingStatus']>) { return this.checks.updateFindingStatus(...args); }
  listFindings(...args: Parameters<ReviewChecksService['listFindings']>) { return this.checks.listFindings(...args); }
  saveApiCheck(...args: Parameters<ReviewChecksService['saveApiCheck']>) { return this.checks.saveApiCheck(...args); }
  listApiChecks(...args: Parameters<ReviewChecksService['listApiChecks']>) { return this.checks.listApiChecks(...args); }
  getReport(...args: Parameters<ReviewReportService['getReport']>) { return this.report.getReport(...args); }
}
