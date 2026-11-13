/**
 * Release gate for a build: findings of the audit against the active quality profile (the same versioned policy staff edit
 * in the console). A required category fails when it has more open critical or high findings than the profile allows, or
 * when a finding has a blocking severity. Not measured items never pass or fail — they are shown as «not measured».
 */
import type { BrowserRule, QualityPolicy } from '../admin/quality-profiles.service.js';
import { tr } from '../i18n/i18n.js';
import type { Category, Finding, Unmeasured } from './site-audit.js';

export const CATEGORIES: Category[] = ['security', 'accessibility', 'performance', 'seo'];
export const categoryTitles: Record<Category, string> = { security: 'Безопасность', accessibility: 'Доступность', performance: 'Скорость', seo: 'Поисковики' };

export type GateCategory = { id: Category; title: string; enabled: boolean; required: boolean; counts: Record<'critical' | 'high' | 'medium' | 'low', number>; status: 'passed' | 'failed' | 'warning' | 'off' };
export type QualityReport = {
  auditVersion: string;
  profile: { key: string; version: number } | null;
  status: 'passed' | 'failed';
  categories: GateCategory[];
  findings: Array<Finding & { blocking: boolean }>;
  unmeasured: Unmeasured[];
  pages: Array<{ path: string; htmlKb: number; imagesKb: number }>;
  summary: string;
  /** Browser thresholds the build must also meet before it is accepted or published (null: browser check is advice only). */
  browserRule?: BrowserRule | null;
};

export function evaluateGate(input: { findings: Finding[]; unmeasured: Unmeasured[]; pages: QualityReport['pages']; auditVersion: string }, policy: QualityPolicy, profile: QualityReport['profile']): QualityReport {
  const findings = input.findings.map((finding) => {
    const rule = policy.categories[finding.category];
    return { ...finding, blocking: rule.enabled && rule.required && policy.blockingSeverities.includes(finding.severity) };
  });
  const categories = CATEGORIES.map((id): GateCategory => {
    const rule = policy.categories[id];
    const mine = findings.filter((finding) => finding.category === id);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of mine) counts[finding.severity] += 1;
    if (!rule.enabled) return { id, title: tr(categoryTitles[id]), enabled: false, required: false, counts, status: 'off' };
    const over = counts.critical > rule.maxOpenCritical || counts.high > rule.maxOpenHigh || mine.some((finding) => finding.blocking);
    const failed = rule.required && over;
    return { id, title: tr(categoryTitles[id]), enabled: true, required: rule.required, counts, status: failed ? 'failed' : mine.length ? 'warning' : 'passed' };
  });
  const status = categories.some((category) => category.status === 'failed') ? 'failed' : 'passed';
  const blocking = findings.filter((finding) => finding.blocking).length;
  const summary = status === 'failed'
    ? tr('Сайт не готов к публикации: {0} обязательных замечаний. Исправьте их и соберите сайт заново.', [Math.max(blocking, 1)])
    : findings.length ? tr('Готов к публикации. Есть {0} необязательных замечаний — их можно исправить позже.', [findings.length]) : tr('Готов к публикации: автоматические проверки замечаний не нашли.');
  return { auditVersion: input.auditVersion, profile, status, categories, findings, unmeasured: input.unmeasured, pages: input.pages, summary, browserRule: policy.browser?.required ? policy.browser : null };
}
