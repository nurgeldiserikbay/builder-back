import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from './url-target-policy.js';
import { PrismaService } from '../database/prisma.service.js';

const reviewSelect = {
  id: true,
  projectId: true,
  title: true,
  mode: true,
  status: true,
  locale: true,
  sourceSnapshotId: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

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

      const review = await tx.reviewRun.create({
        data: { projectId, ownerUserId: userId, ...input },
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
      if (!this.isUniqueViolation(error)) throw error;
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
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
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
    if (!this.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
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
        label: page.title ?? page.route,
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
      if (!this.isUniqueViolation(error)) throw error;
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

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
