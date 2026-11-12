// The HTML/JSON report of a review, with the quality gate.
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ReviewsCore } from './reviews-core.js';
import { normalizeAiDesignAnalysis, isRecord, evaluateQualityGate } from './review-shared.js';

@Injectable()
export class ReviewReportService {
  constructor(private readonly prisma: PrismaService, private readonly core: ReviewsCore) {}

  async getReport(userId: string, reviewId: string) {
    if (!this.core.isUuid(reviewId)) throw new NotFoundException('REVIEW_NOT_FOUND');
    const review = await this.prisma.reviewRun.findFirst({
      where: { id: reviewId, project: { members: { some: { userId, status: 'active' } } } },
      select: {
        id: true, projectId: true, title: true, mode: true, status: true, locale: true,
        baseOrigin: true, configuration: true, createdAt: true, updatedAt: true,
        pages: {
          where: { status: { not: 'excluded' } },
          orderBy: [{ route: 'asc' }],
          take: 100,
          select: {
            id: true, route: true, title: true, status: true,
            mapping: { select: { designSourceId: true } },
            captures: { orderBy: [{ createdAt: 'desc' }], take: 1, select: { status: true, capturedAt: true, visualDiff: true, qualityAudit: true, aiAnalysis: true } },
            requirements: {
              orderBy: [{ createdAt: 'asc' }],
              take: 200,
              select: { id: true, category: true, title: true, status: true, verificationNote: true, evidenceCaptureId: true },
            },
            findings: {
              orderBy: [{ createdAt: 'desc' }],
              take: 100,
              select: { id: true, category: true, severity: true, status: true, summary: true, createdAt: true },
            },
            apiChecks: {
              orderBy: [{ createdAt: 'desc' }],
              take: 50,
              select: { id: true, requirementId: true, method: true, endpoint: true, expectedStatus: true, actualStatus: true, durationMs: true, passed: true, jsonPath: true, jsonMatches: true, safeErrorCode: true, checkedAt: true },

            },
          },
        },
      },
    });
    if (!review) throw new NotFoundException('REVIEW_NOT_FOUND');

    const countStatuses = (items: Array<{ status: string }>) =>
      items.reduce<Record<string, number>>((counts, item) => {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        return counts;
      }, {});
    const requirements = review.pages.flatMap((page) => page.requirements);
    const findings = review.pages.flatMap((page) => page.findings);
    const pages = review.pages.map((page) => {
      const capture = page.captures[0] ?? null;
      let visualDiff: { status: 'ready' | 'failed'; changedPercent: number | null } | null = null;
      if (capture?.visualDiff && typeof capture.visualDiff === 'object' && !Array.isArray(capture.visualDiff)) {
        const storedDiff = capture.visualDiff as Record<string, unknown>;
        if (storedDiff.status === 'ready' || storedDiff.status === 'failed') {
          const rawPercent = storedDiff.changedPercent;
          visualDiff = {
            status: storedDiff.status,
            changedPercent: typeof rawPercent === 'number' && Number.isFinite(rawPercent)
              ? Math.round(Math.max(0, Math.min(100, rawPercent)) * 10) / 10
              : null,
          };
        }
      }
      const aiAnalysis = capture ? normalizeAiDesignAnalysis(capture.aiAnalysis) : null;
      let qualityAudit: {
        checkedAt: string | null; pageTitlePresent: boolean; languagePresent: boolean; h1Count: number;
        imagesMissingAlt: number; linksMissingName: number; buttonsMissingName: number; formControlsMissingLabel: number;
        performance: { navigationMs: number | null; ttfbMs: number | null; transferBytes: number; resourceCount: number } | null;
        security: { isHttps: boolean; hsts: boolean | null; contentSecurityPolicy: boolean; xContentTypeOptions: boolean; referrerPolicy: boolean; permissionsPolicy: boolean; frameProtection: boolean } | null;
      } | null = null;
      if (capture?.qualityAudit && typeof capture.qualityAudit === 'object' && !Array.isArray(capture.qualityAudit)) {
        const audit = capture.qualityAudit as Record<string, unknown>;
        const safeCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(100000, value)) : 0;
        const performance = isRecord(audit.performance) ? audit.performance : null;
        const security = isRecord(audit.security) ? audit.security : null;
        const safeMetric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(50 * 1024 * 1024, Math.round(value)) : null;
        qualityAudit = {
          checkedAt: typeof audit.checkedAt === 'string' ? audit.checkedAt : null,
          pageTitlePresent: audit.pageTitlePresent === true,
          languagePresent: audit.languagePresent === true,
          h1Count: safeCount(audit.h1Count),
          imagesMissingAlt: safeCount(audit.imagesMissingAlt),
          linksMissingName: safeCount(audit.linksMissingName),
          buttonsMissingName: safeCount(audit.buttonsMissingName),
          formControlsMissingLabel: safeCount(audit.formControlsMissingLabel),
          performance: performance ? {
            navigationMs: safeMetric(performance.navigationMs),
            ttfbMs: safeMetric(performance.ttfbMs),
            transferBytes: safeCount(performance.transferBytes),
            resourceCount: safeCount(performance.resourceCount),
          } : null,
          security: security && typeof security.isHttps === 'boolean' ? {
            isHttps: security.isHttps,
            hsts: typeof security.hsts === 'boolean' ? security.hsts : null,
            contentSecurityPolicy: security.contentSecurityPolicy === true,
            xContentTypeOptions: security.xContentTypeOptions === true,
            referrerPolicy: security.referrerPolicy === true,
            permissionsPolicy: security.permissionsPolicy === true,
            frameProtection: security.frameProtection === true,
          } : null,
        };
      }
      return {
        id: page.id,
        route: page.route,
        title: page.title,
        status: page.status,
        designMapped: Boolean(page.mapping?.designSourceId),
        latestCapture: capture ? { status: capture.status, capturedAt: capture.capturedAt, visualDiff, qualityAudit, aiAnalysis } : null,
        requirements: page.requirements,
        findings: page.findings,
        apiChecks: page.apiChecks,
      };
    });
    const signals: Array<{ id: string; code: string; severity: 'high' | 'medium' | 'info'; pageId: string; requirementId: string | null; title: string; details: string }> = [];
    const addSignal = (pageId: string, code: string, severity: 'high' | 'medium' | 'info', requirementId: string | null, title: string, details: string) => {
      signals.push({ id: [code, pageId, requirementId ?? 'page'].join(':'), code, severity, pageId, requirementId, title, details });
    };
    for (const page of pages) {
      if (review.mode === 'site_and_design' && !page.designMapped) {
        addSignal(page.id, 'DESIGN_NOT_MAPPED', 'medium', null, 'Для страницы не назначен макет', 'Сопоставьте страницу с макетом, чтобы результат сравнения отражал дизайн-ТЗ.');
      }
      if (!page.latestCapture) {
        addSignal(page.id, 'SITE_NOT_CAPTURED', 'medium', null, 'Нет снимка рабочей страницы', 'Запустите захват страницы перед оценкой сайта и сравнением с макетом.');
      } else if (page.latestCapture.status === 'failed') {
        addSignal(page.id, 'CAPTURE_FAILED', 'high', null, 'Не удалось получить снимок страницы', 'Проверьте доступность URL и повторите захват.');
      }
      const audit = page.latestCapture?.qualityAudit;
      if (audit) {
        if (!audit.pageTitlePresent) addSignal(page.id, 'PAGE_TITLE_MISSING', 'medium', null, 'У страницы нет заголовка вкладки', 'Добавьте осмысленный элемент <title>.');
        if (!audit.languagePresent) addSignal(page.id, 'PAGE_LANGUAGE_MISSING', 'medium', null, 'Не указан язык документа', 'Задайте атрибут lang у корневого элемента HTML.');
        if (audit.h1Count === 0) addSignal(page.id, 'PRIMARY_HEADING_MISSING', 'medium', null, 'Не найден заголовок первого уровня', 'Проверьте структуру заголовков и добавьте основной заголовок, если он нужен странице.');
        if (audit.imagesMissingAlt > 0) addSignal(page.id, 'IMAGES_MISSING_ALT', 'medium', null, 'У изображений отсутствует alt', `Изображений без атрибута alt: ${audit.imagesMissingAlt}. Проверьте, какие изображения несут смысл.`);
        if (audit.linksMissingName > 0) addSignal(page.id, 'LINKS_MISSING_NAME', 'high', null, 'Есть ссылки без доступного названия', `Ссылок без текста или доступной подписи: ${audit.linksMissingName}.`);
        if (audit.buttonsMissingName > 0) addSignal(page.id, 'BUTTONS_MISSING_NAME', 'high', null, 'Есть кнопки без доступного названия', `Кнопок без текста или доступной подписи: ${audit.buttonsMissingName}.`);
        if (audit.formControlsMissingLabel > 0) addSignal(page.id, 'FORM_LABELS_MISSING', 'medium', null, 'У полей формы отсутствуют подписи', `Полей без связанной подписи: ${audit.formControlsMissingLabel}.`);
      }
      const changedPercent = page.latestCapture?.visualDiff?.changedPercent;
      if (page.latestCapture?.visualDiff?.status === 'ready' && changedPercent !== null && changedPercent !== undefined && changedPercent >= 20) {
        addSignal(page.id, 'LARGE_VISUAL_DIFFERENCE', 'medium', null, 'Большое отличие от макета', `Пиксельное отличие составляет ${changedPercent}%. Проверьте области отличия вручную.`);
      }
      for (const requirement of page.requirements) {
        if (requirement.status === 'failed') {
          addSignal(page.id, 'REQUIREMENT_FAILED', 'high', requirement.id, 'Пункт ТЗ отмечен как невыполненный', requirement.title);
        } else if (requirement.status === 'blocked') {
          addSignal(page.id, 'REQUIREMENT_BLOCKED', 'medium', requirement.id, 'Пункт ТЗ заблокирован', requirement.title);
        } else if (requirement.status === 'pending' || requirement.status === 'unknown') {
          addSignal(page.id, 'REQUIREMENT_UNVERIFIED', 'medium', requirement.id, 'Пункт ТЗ ещё не подтверждён', requirement.title);
        }
        if (requirement.category === 'backend') {
          const checks = page.apiChecks.filter((check) => check.requirementId === requirement.id);
          if (checks.length === 0) {
            addSignal(page.id, 'BACKEND_REQUIREMENT_UNTESTED', 'medium', requirement.id, 'Для backend-пункта нет API-проверки', requirement.title);
          } else if (!checks[0].passed) {
            addSignal(page.id, 'API_CHECK_FAILED', 'high', requirement.id, 'Последняя API-проверка не пройдена', requirement.title);
          }
        }
      }
      for (const finding of page.findings) {
        if (finding.status === 'open' && (finding.severity === 'critical' || finding.severity === 'high')) {
          addSignal(page.id, 'HIGH_SEVERITY_FINDING', 'high', null, 'Открыто важное замечание', finding.summary);
        }
      }
    }
    signals.sort((a, b) => ({ high: 0, medium: 1, info: 2 }[a.severity] - { high: 0, medium: 1, info: 2 }[b.severity]));
    signals.splice(500);
    const signalCounts = signals.reduce<Record<string, number>>((counts, signal) => {
      counts[signal.severity] = (counts[signal.severity] ?? 0) + 1;
      return counts;
    }, {});
    const comparedPages = pages.filter((page) => page.latestCapture?.visualDiff?.status === 'ready'
      && page.latestCapture.visualDiff.changedPercent !== null);
    const averageChangedPercent = comparedPages.length > 0
      ? Math.round(comparedPages.reduce((sum, page) => sum + (page.latestCapture?.visualDiff?.changedPercent ?? 0), 0) / comparedPages.length * 10) / 10
      : null;
    const aiAnalyses = pages.flatMap((page) => page.latestCapture?.aiAnalysis ? [page.latestCapture.aiAnalysis] : []);
    const aiSuggestions = aiAnalyses.flatMap((analysis) => analysis.findings);
    const aiByConfidence = aiSuggestions.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.confidence] = (counts[finding.confidence] ?? 0) + 1;
      return counts;
    }, {});
    const mappedPages = pages.filter((page) => page.designMapped);
    const backendRequirements = pages.flatMap((page) => page.requirements
      .filter((requirement) => requirement.category === 'backend')
      .map((requirement) => ({
        requirementId: requirement.id,
        checked: page.apiChecks.some((check) => check.requirementId === requirement.id),
      })));
    const coverage = {
      site: {
        checked: pages.filter((page) => page.latestCapture?.status === 'captured').length,
        total: pages.length,
      },
      requirements: {
        satisfied: requirements.filter((requirement) => requirement.status === 'satisfied').length,
        total: requirements.length,
      },
      design: {
        compared: mappedPages.filter((page) => page.latestCapture?.visualDiff?.status === 'ready'
          && page.latestCapture.visualDiff.changedPercent !== null).length,
        total: mappedPages.length,
      },
      backend: {
        checked: backendRequirements.filter((requirement) => requirement.checked).length,
        total: backendRequirements.length,
      },
    };

    const generatedAt = new Date().toISOString();
    const qualityGate = evaluateQualityGate(review.configuration, pages, requirements, generatedAt);
    return {
      data: {
        schemaVersion: 5,
        generatedAt,
        review: {
          id: review.id,
          projectId: review.projectId,
          title: review.title,
          mode: review.mode,
          status: review.status,
          locale: review.locale,
          siteOrigin: review.baseOrigin,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
        },
        qualityGate,
        summary: {
          coverage,
          pages: {
            total: pages.length,
            mapped: pages.filter((page) => page.designMapped).length,
            captured: pages.filter((page) => page.latestCapture?.status === 'captured').length,
          },
          visualDiff: { compared: comparedPages.length, averageChangedPercent },
          requirements: { total: requirements.length, byStatus: countStatuses(requirements) },
          findings: { total: findings.length, byStatus: countStatuses(findings) },
          apiChecks: { totalRecent: pages.reduce((total, page) => total + page.apiChecks.length, 0), passedRecent: pages.reduce((total, page) => total + page.apiChecks.filter((check) => check.passed).length, 0) },
          aiReview: { analyzedCaptures: aiAnalyses.length, totalSuggestions: aiSuggestions.length, byConfidence: aiByConfidence },
          analysis: { source: 'rules_v1', totalSignals: signals.length, bySeverity: signalCounts },
        },
        pages,
        signals,
        limitations: [
          'Visual comparison reports pixel differences only; it does not determine semantic design compliance.',
          'Rule-based signals summarize missing evidence and recorded outcomes; they do not infer semantic design compliance or replace AI/reviewer analysis.',
          'Page structure and accessibility checks are heuristic DOM counts; they are not a complete WCAG audit.',
          'API checks are user-run GET/HEAD probes; they do not replace full backend integration or security testing.',
          'The configured quality gate evaluates available report evidence only. Full security and performance assessments are not implemented, and a report result does not authorize publication.',
          'Page, requirement, finding, and API-check lists are capped at 100, 200 per page, 100 per page, and 50 recent checks per page respectively; rule-based signals are capped at 500 per report.',
        ],
      },
    };
  }
}
