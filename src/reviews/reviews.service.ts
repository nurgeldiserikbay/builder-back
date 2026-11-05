import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
