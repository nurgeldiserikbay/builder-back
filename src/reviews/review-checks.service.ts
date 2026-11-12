// Findings, requirement checklist and API checks of a page.
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { ReviewsCore } from './reviews-core.js';

@Injectable()
export class ReviewChecksService {
  constructor(private readonly prisma: PrismaService, private readonly core: ReviewsCore) {}

  async createFinding(userId: string, reviewId: string, idempotencyKey: string, input: {
    evidenceCaptureId: string;
    category: 'requirement' | 'design' | 'backend' | 'accessibility' | 'performance' | 'seo' | 'security';
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    summary: string;
    coordinate: { x: number; y: number } | null;
  }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const capture = await this.prisma.reviewCapture.findFirst({
      where: { id: input.evidenceCaptureId, status: 'captured', page: { reviewRunId: reviewId } },
      select: { id: true, pageId: true },
    });
    if (!capture) throw new UnprocessableEntityException('FINDING_CAPTURE_NOT_AVAILABLE');
    const normalized = { ...input, summary: input.summary.trim(), coordinate: input.coordinate ?? null };
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const scope = `finding:create:${reviewId}`;
    const now = new Date();
    const persist = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        const existing = await tx.reviewFinding.findFirst({
          where: { id: previous.resourceId, reviewRunId: reviewId },
          select: { id: true, pageId: true, category: true, severity: true, status: true, confidence: true, summary: true, coordinates: true, evidence: true, createdAt: true, updatedAt: true },
        });
        if (existing) return existing;
      }
      if (previous) await tx.idempotencyRecord.delete({ where: { id: previous.id } });
      const finding = await tx.reviewFinding.create({
        data: {
          reviewRunId: reviewId, pageId: capture.pageId, category: normalized.category, severity: normalized.severity,
          status: 'open', confidence: 'low', summary: normalized.summary.slice(0, 500),
          explanation: 'Recorded manually by a reviewer; verify against the approved requirements and design.',
          evidence: { captureId: capture.id }, ...(normalized.coordinate ? { coordinates: normalized.coordinate } : {}),
          authorUserId: userId,
        },
        select: { id: true, pageId: true, category: true, severity: true, status: true, confidence: true, summary: true, coordinates: true, evidence: true, createdAt: true, updatedAt: true },
      });
      await tx.idempotencyRecord.create({
        data: { userId, scope, key: idempotencyKey, requestHash, resourceId: finding.id, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      });
      return finding;
    });
    try {
      const finding = await persist();
      return { data: finding };
    } catch (error) {
      if (!this.core.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (!previous || previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      const finding = await this.prisma.reviewFinding.findFirst({
        where: { id: previous.resourceId, reviewRunId: reviewId },
        select: { id: true, pageId: true, category: true, severity: true, status: true, confidence: true, summary: true, coordinates: true, evidence: true, createdAt: true, updatedAt: true },
      });
      if (!finding) throw error;
      return { data: finding };
    }
  }

  async createRequirement(userId: string, reviewId: string, idempotencyKey: string, input: {
    pageId: string;
    title: string;
    category: 'requirement' | 'design' | 'backend' | 'accessibility' | 'performance' | 'seo' | 'security';
    details?: string | null;
  }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const page = await this.prisma.reviewPage.findFirst({
      where: { id: input.pageId, reviewRunId: reviewId },
      select: { id: true },
    });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    const normalized = { ...input, title: input.title.trim(), details: input.details?.trim() || null };
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const scope = `requirement:create:${reviewId}`;
    const now = new Date();
    const select = { id: true, pageId: true, category: true, title: true, details: true, status: true, verificationNote: true, evidenceCaptureId: true, createdAt: true, updatedAt: true } as const;
    const persist = () => this.prisma.$transaction(async (tx) => {
      const previous = await tx.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
        const existing = await tx.reviewRequirement.findFirst({ where: { id: previous.resourceId, reviewRunId: reviewId }, select });
        if (existing) return existing;
      }
      if (previous) await tx.idempotencyRecord.delete({ where: { id: previous.id } });
      const requirement = await tx.reviewRequirement.create({
        data: {
          reviewRunId: reviewId, pageId: page.id, category: normalized.category, title: normalized.title.slice(0, 500),
          ...(normalized.details ? { details: normalized.details.slice(0, 4000) } : {}), authorUserId: userId,
        },
        select,
      });
      await tx.idempotencyRecord.create({
        data: { userId, scope, key: idempotencyKey, requestHash, resourceId: requirement.id, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      });
      return requirement;
    });
    try {
      return { data: await persist() };
    } catch (error) {
      if (!this.core.isUniqueViolation(error)) throw error;
      const previous = await this.prisma.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId, scope, key: idempotencyKey } },
      });
      if (!previous || previous.requestHash !== requestHash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      const requirement = await this.prisma.reviewRequirement.findFirst({ where: { id: previous.resourceId, reviewRunId: reviewId }, select });
      if (!requirement) throw error;
      return { data: requirement };
    }
  }

  async listRequirements(userId: string, reviewId: string, pageId: string) {
    await this.core.reviewForAsset(userId, reviewId);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true } });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    const data = await this.prisma.reviewRequirement.findMany({
      where: { reviewRunId: reviewId, pageId: page.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { id: true, pageId: true, category: true, title: true, details: true, status: true, verificationNote: true, evidenceCaptureId: true, createdAt: true, updatedAt: true },
    });
    return { data };
  }

  async updateRequirement(userId: string, reviewId: string, requirementId: string, input: {
    status: 'pending' | 'satisfied' | 'failed' | 'blocked' | 'unknown';
    verificationNote?: string | null;
    evidenceCaptureId?: string | null;
  }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const requirement = await this.prisma.reviewRequirement.findFirst({
      where: { id: requirementId, reviewRunId: reviewId },
      select: { id: true, pageId: true, evidenceCaptureId: true },
    });
    if (!requirement) throw new NotFoundException('REVIEW_REQUIREMENT_NOT_FOUND');
    const evidenceCaptureId = input.evidenceCaptureId === undefined ? requirement.evidenceCaptureId : input.evidenceCaptureId;
    if (input.status === 'satisfied' && !evidenceCaptureId) throw new UnprocessableEntityException('REQUIREMENT_EVIDENCE_REQUIRED');
    if (evidenceCaptureId) {
      const capture = await this.prisma.reviewCapture.findFirst({
        where: { id: evidenceCaptureId, status: 'captured', page: { reviewRunId: reviewId } },
        select: { id: true, pageId: true },
      });
      if (!capture || (requirement.pageId && capture.pageId !== requirement.pageId)) throw new UnprocessableEntityException('REQUIREMENT_EVIDENCE_NOT_AVAILABLE');
    }
    const updated = await this.prisma.reviewRequirement.update({
      where: { id: requirement.id },
      data: {
        status: input.status,
        verificationNote: input.verificationNote === undefined ? undefined : input.verificationNote?.trim().slice(0, 2000) || null,
        evidenceCaptureId,
      },
      select: { id: true, pageId: true, category: true, title: true, details: true, status: true, verificationNote: true, evidenceCaptureId: true, createdAt: true, updatedAt: true },
    });
    return { data: updated };
  }

  async updateFindingStatus(userId: string, reviewId: string, findingId: string, status: 'open' | 'accepted' | 'dismissed' | 'fixed' | 'unknown') {
    await this.core.reviewForAsset(userId, reviewId, true);
    const finding = await this.prisma.reviewFinding.findFirst({
      where: { id: findingId, reviewRunId: reviewId },
      select: { id: true },
    });
    if (!finding) throw new NotFoundException('REVIEW_FINDING_NOT_FOUND');
    const updated = await this.prisma.reviewFinding.update({
      where: { id: finding.id },
      data: { status },
      select: { id: true, pageId: true, category: true, severity: true, status: true, confidence: true, summary: true, coordinates: true, evidence: true, createdAt: true, updatedAt: true },
    });
    return { data: updated };
  }

  async listFindings(userId: string, reviewId: string, pageId: string) {
    await this.core.reviewForAsset(userId, reviewId);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true } });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    const findings = await this.prisma.reviewFinding.findMany({
      where: { reviewRunId: reviewId, pageId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, pageId: true, category: true, severity: true, status: true, confidence: true, summary: true, coordinates: true, evidence: true, createdAt: true, updatedAt: true },
    });
    return { data: findings };
  }


  async saveApiCheck(userId: string, reviewId: string, pageId: string, input: {
    method: 'GET' | 'HEAD'; endpoint: string; expectedStatus: number; actualStatus: number | null;
    durationMs: number; jsonPath: string | null; jsonMatches: boolean | null;
    safeErrorCode: 'REQUEST_FAILED' | 'REQUEST_TIMEOUT' | null; checkedAt: string; requirementId: string | null;
  }) {
    await this.core.reviewForAsset(userId, reviewId, true);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true } });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    let target: URL;
    try { target = new URL(input.endpoint); } catch { throw new BadRequestException('INVALID_API_CHECK_ENDPOINT'); }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && localHost)) || target.username || target.password || target.search || target.hash || target.href !== input.endpoint || input.endpoint.length > 2048) {
      throw new BadRequestException('INVALID_API_CHECK_ENDPOINT');
    }
    const checkedAt = new Date(input.checkedAt);
    if (!Number.isFinite(checkedAt.getTime()) || Math.abs(Date.now() - checkedAt.getTime()) > 5 * 60 * 1000) throw new BadRequestException('INVALID_API_CHECK_TIME');
    if (!['GET', 'HEAD'].includes(input.method)) throw new BadRequestException('INVALID_API_CHECK_METHOD');
    if (!Number.isInteger(input.expectedStatus) || input.expectedStatus < 100 || input.expectedStatus > 599) throw new BadRequestException('INVALID_API_CHECK_STATUS');
    if (input.actualStatus !== null && (!Number.isInteger(input.actualStatus) || input.actualStatus < 100 || input.actualStatus > 599)) throw new BadRequestException('INVALID_API_CHECK_STATUS');
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 12000) throw new BadRequestException('INVALID_API_CHECK_DURATION');
    if (input.jsonPath !== null && (input.jsonPath.length > 160 || !input.jsonPath.trim())) throw new BadRequestException('INVALID_API_CHECK_JSON_PATH');
    if (input.safeErrorCode !== null && !['REQUEST_FAILED', 'REQUEST_TIMEOUT'].includes(input.safeErrorCode)) throw new BadRequestException('INVALID_API_CHECK_ERROR');
    if (input.safeErrorCode && input.actualStatus !== null) throw new BadRequestException('INVALID_API_CHECK_RESULT');
    if (input.jsonMatches !== null && input.jsonPath === null) throw new BadRequestException('INVALID_API_CHECK_RESULT');
    if (input.requirementId !== null) {
      const requirement = await this.prisma.reviewRequirement.findFirst({
        where: { id: input.requirementId, reviewRunId: reviewId, pageId, category: 'backend' },
        select: { id: true },
      });
      if (!requirement) throw new UnprocessableEntityException('API_CHECK_REQUIREMENT_NOT_AVAILABLE');
    }
    const passed = input.actualStatus === input.expectedStatus && input.jsonMatches !== false && input.safeErrorCode === null;
    const created = await this.prisma.reviewApiCheck.create({
      data: { reviewRunId: reviewId, pageId, requirementId: input.requirementId, authorUserId: userId, method: input.method, endpoint: target.origin + target.pathname,
        expectedStatus: input.expectedStatus, actualStatus: input.actualStatus, durationMs: input.durationMs, passed,
        jsonPath: input.jsonPath?.trim() || null, jsonMatches: input.jsonMatches, safeErrorCode: input.safeErrorCode, checkedAt },
      select: { id: true, requirementId: true, method: true, endpoint: true, expectedStatus: true, actualStatus: true, durationMs: true, passed: true, jsonPath: true, jsonMatches: true, safeErrorCode: true, checkedAt: true, createdAt: true },
    });
    const retained = await this.prisma.reviewApiCheck.findMany({ where: { reviewRunId: reviewId, pageId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, select: { id: true } });
    await this.prisma.reviewApiCheck.deleteMany({ where: { reviewRunId: reviewId, pageId, id: { notIn: retained.map((item) => item.id) } } });
    return { data: created };
  }

  async listApiChecks(userId: string, reviewId: string, pageId: string) {
    await this.core.reviewForAsset(userId, reviewId);
    const page = await this.prisma.reviewPage.findFirst({ where: { id: pageId, reviewRunId: reviewId }, select: { id: true } });
    if (!page) throw new NotFoundException('REVIEW_PAGE_NOT_FOUND');
    const data = await this.prisma.reviewApiCheck.findMany({
      where: { reviewRunId: reviewId, pageId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
      select: { id: true, requirementId: true, method: true, endpoint: true, expectedStatus: true, actualStatus: true, durationMs: true, passed: true, jsonPath: true, jsonMatches: true, safeErrorCode: true, checkedAt: true, createdAt: true },
    });
    return { data };
  }
}
