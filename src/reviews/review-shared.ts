// Shared pieces of the site check: AI design analysis shape, the quality gate evaluation and the review query shape.
import { parseQualityPolicy } from '../admin/quality-profiles.service.js';
import type { QualityPolicy } from '../admin/quality-profiles.service.js';

export type AiDesignAnalysis = {
  status: 'complete';
  provider: 'openai';
  model: string;
  createdAt: string;
  summary: string;
  findings: Array<{
    category: 'design';
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    confidence: 'low' | 'medium' | 'high';
    summary: string;
    details: string;
    evidence: string;
  }>;
  limitation: string;
};

export function normalizeAiDesignAnalysis(value: unknown): AiDesignAnalysis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.status !== 'complete' || item.provider !== 'openai' || typeof item.model !== 'string'
    || typeof item.createdAt !== 'string' || typeof item.summary !== 'string'
    || typeof item.limitation !== 'string' || !Array.isArray(item.findings)) return null;
  const categories = ['design'];
  const severities = ['critical', 'high', 'medium', 'low', 'info'];
  const confidences = ['low', 'medium', 'high'];
  const findings = item.findings.slice(0, 12).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const finding = raw as Record<string, unknown>;
    if (!categories.includes(String(finding.category)) || !severities.includes(String(finding.severity))
      || !confidences.includes(String(finding.confidence))) return [];
    if (typeof finding.summary !== 'string' || typeof finding.details !== 'string' || typeof finding.evidence !== 'string') return [];
    return [{
      category: finding.category as AiDesignAnalysis['findings'][number]['category'],
      severity: finding.severity as AiDesignAnalysis['findings'][number]['severity'],
      confidence: finding.confidence as AiDesignAnalysis['findings'][number]['confidence'],
      summary: finding.summary.slice(0, 300),
      details: finding.details.slice(0, 1200),
      evidence: finding.evidence.slice(0, 500),
    }];
  });
  return {
    status: 'complete', provider: 'openai', model: item.model.slice(0, 80), createdAt: item.createdAt,
    summary: item.summary.slice(0, 1200), findings, limitation: item.limitation.slice(0, 500),
  };
}

export type QualityGatePage = { latestCapture: { qualityAudit: unknown } | null; findings: Array<{ category: string; severity: string; status: string }>; apiChecks: Array<{ passed: boolean }> };
export type QualityGateRequirement = { status: string };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function evaluateQualityGate(configuration: unknown, pages: QualityGatePage[], requirements: QualityGateRequirement[], evaluatedAt: string) {
  const apiChecks = pages.flatMap((page) => page.apiChecks);
  const apiCheckSummary = { checked: apiChecks.length, failed: apiChecks.filter((check) => !check.passed).length };
  const config = isRecord(configuration) ? configuration.qualityProfile : null;
  if (config === null || config === undefined) {
    return {
      status: 'not_configured' as const,
      profile: null,
      evaluatedAt,
      requirementCoverage: { status: 'not_applicable' as const, actualPercent: null, minimumPercent: null },
      apiChecks: apiCheckSummary,
      categories: [],
      blockingReasons: [],
    };
  }
  if (!isRecord(config) || typeof config.key !== 'string' || typeof config.name !== 'string'
    || typeof config.version !== 'number' || !Number.isInteger(config.version)) {
    return {
      status: 'invalid_configuration' as const,
      profile: null,
      evaluatedAt,
      requirementCoverage: { status: 'not_applicable' as const, actualPercent: null, minimumPercent: null },
      apiChecks: apiCheckSummary,
      categories: [],
      blockingReasons: ['profile_snapshot_invalid'],
    };
  }
  let policy: QualityPolicy;
  try { policy = parseQualityPolicy(config.policy); }
  catch {
    return {
      status: 'invalid_configuration' as const,
      profile: { key: config.key, name: config.name, version: config.version },
      evaluatedAt,
      requirementCoverage: { status: 'not_applicable' as const, actualPercent: null, minimumPercent: null },
      apiChecks: apiCheckSummary,
      categories: [],
      blockingReasons: ['profile_policy_invalid'],
    };
  }

  const blockingReasons: string[] = [];
  if (apiCheckSummary.failed > 0) blockingReasons.push('backend_api_check_failed');
  const satisfied = requirements.filter((requirement) => requirement.status === 'satisfied').length;
  const actualRequirementCoverage = requirements.length > 0 ? Math.round(satisfied / requirements.length * 100) : null;
  const requirementCoverage = requirements.length === 0
    ? { status: 'not_applicable' as const, actualPercent: null, minimumPercent: policy.minimumRequirementCoverage }
    : {
      status: (actualRequirementCoverage ?? 0) >= policy.minimumRequirementCoverage ? 'passed' as const : 'blocked' as const,
      actualPercent: actualRequirementCoverage,
      minimumPercent: policy.minimumRequirementCoverage,
    };
  if (requirementCoverage.status === 'blocked') blockingReasons.push('requirements_coverage_below_minimum');

  const categoryIds = ['security', 'accessibility', 'performance', 'seo'] as const;
  const categories = categoryIds.map((id) => {
    const rule = policy.categories[id];
    const evidenceChecked = pages.filter((page) => {
      const audit = isRecord(page.latestCapture?.qualityAudit) ? page.latestCapture.qualityAudit : null;
      if (!audit) return false;
      if (id === 'security') return isRecord(audit.security) && typeof audit.security.isHttps === 'boolean';
      if (id === 'performance') return isRecord(audit.performance) && typeof audit.performance.resourceCount === 'number';
      return true;
    }).length;
    const evidence = { checked: evidenceChecked, total: pages.length };
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    const addCount = (severity: keyof typeof counts, amount = 1) => { counts[severity] = Math.min(100000, counts[severity] + amount); };
    const safeCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(100000, value)) : 0;
    const safeMetric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(50 * 1024 * 1024, value) : null;
    for (const page of pages) {
      for (const finding of page.findings) {
        if (finding.category === id && finding.status === 'open' && finding.severity in counts) addCount(finding.severity as keyof typeof counts);
      }
      const audit = isRecord(page.latestCapture?.qualityAudit) ? page.latestCapture.qualityAudit : null;
      if (!audit) continue;
      if (id === 'accessibility') {
        addCount('high', safeCount(audit.linksMissingName) + safeCount(audit.buttonsMissingName));
        addCount('medium', safeCount(audit.imagesMissingAlt) + safeCount(audit.formControlsMissingLabel));
      }
      if (id === 'seo') {
        addCount('medium', (audit.pageTitlePresent === true ? 0 : 1) + (audit.languagePresent === true ? 0 : 1) + (safeCount(audit.h1Count) === 0 ? 1 : 0));
      }
      if (id === 'security' && isRecord(audit.security) && typeof audit.security.isHttps === 'boolean') {
        const security = audit.security;
        if (!security.isHttps) addCount('high');
        if (security.isHttps && security.hsts === false) addCount('medium');
        if (security.contentSecurityPolicy === false) addCount('medium');
        if (security.frameProtection === false) addCount('medium');
        if (security.xContentTypeOptions === false) addCount('low');
        if (security.referrerPolicy === false) addCount('low');
        if (security.permissionsPolicy === false) addCount('low');
      }
      if (id === 'performance' && isRecord(audit.performance)) {
        const navigationMs = safeMetric(audit.performance.navigationMs);
        const ttfbMs = safeMetric(audit.performance.ttfbMs);
        const transferBytes = safeMetric(audit.performance.transferBytes);
        const resourceCount = safeCount(audit.performance.resourceCount);
        if (navigationMs !== null) addCount(navigationMs > 8000 ? 'high' : navigationMs > 4000 ? 'medium' : 'low', navigationMs > 4000 ? 1 : 0);
        if (ttfbMs !== null) addCount(ttfbMs > 3000 ? 'high' : ttfbMs > 1000 ? 'medium' : 'low', ttfbMs > 1000 ? 1 : 0);
        if (transferBytes !== null) addCount(transferBytes > 8 * 1024 * 1024 ? 'high' : transferBytes > 3 * 1024 * 1024 ? 'medium' : 'low', transferBytes > 3 * 1024 * 1024 ? 1 : 0);
        if (resourceCount > 250) addCount('medium');
      }
    }
    if (!rule.enabled) return { id, enabled: false, required: rule.required, status: 'disabled' as const, evidence, issues: counts, reasons: [] as string[] };
    const reasons: string[] = [];
    if (rule.required && (evidence.total === 0 || evidence.checked < evidence.total)) reasons.push(id === 'security' || id === 'performance' ? 'assessment_not_supported' : 'evidence_incomplete');
    for (const severity of policy.blockingSeverities) {
      const allowed = severity === 'critical' ? rule.maxOpenCritical : severity === 'high' ? rule.maxOpenHigh : 0;
      if (counts[severity as keyof typeof counts] > allowed) reasons.push(`${severity}_finding_limit_exceeded`);
    }
    if (reasons.length > 0) blockingReasons.push(...reasons.map((reason) => `${id}:${reason}`));
    const status = reasons.length > 0 ? 'blocked' as const : evidence.checked > 0 && evidence.checked === evidence.total ? 'passed' as const : 'not_assessed' as const;
    return { id, enabled: true, required: rule.required, status, evidence, issues: counts, reasons };
  });
  const hasApplicableCheck = requirements.length > 0 || categories.some((item) => item.enabled && item.required);
  return {
    status: blockingReasons.length > 0 ? 'blocked' as const : hasApplicableCheck ? 'passed' as const : 'not_assessed' as const,
    profile: { key: config.key, name: config.name, version: config.version },
    evaluatedAt,
    requirementCoverage,
    apiChecks: apiCheckSummary,
    categories,
    blockingReasons,
  };
}

export const reviewSelect = {
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
