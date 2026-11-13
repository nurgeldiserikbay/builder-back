// The browser part of the release gate. Only when the build's quality profile requires it: the Lighthouse check of
// that build must have succeeded and every measured page must meet the thresholds. A check that could not run is
// not a pass — the build waits or is checked again (fail closed), and the reason is said plainly.

import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { BrowserRule, BrowserScoreKey } from '../admin/quality-profiles.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import type { BrowserCheckResult } from './browser-check.js';

export type BrowserGate = { status: 'passed' | 'pending' | 'failed' | 'unavailable'; reasons: string[] };
const scoreTitles: Record<BrowserScoreKey, string> = { performance: 'Скорость', accessibility: 'Доступность', 'best-practices': 'Надёжность', seo: 'Поисковики' };

/** Pure: the verdict for one build. Pages that could not be measured count as not meeting the rule. */
export function evaluateBrowserGate(rule: BrowserRule, check: { status: string; result: unknown } | null): BrowserGate {
  if (!check || check.status === 'queued' || check.status === 'running') return { status: 'pending', reasons: [tr('Проверка в браузере ещё не закончилась.')] };
  if (check.status !== 'succeeded') return { status: 'unavailable', reasons: [tr('Проверка в браузере не получилась, а правила проекта её требуют. Запустите её ещё раз.')] };
  const result = check.result as BrowserCheckResult | null;
  const reasons: string[] = [];
  for (const page of result?.pages ?? []) {
    if (page.error) { reasons.push(tr('Страница {0}: не удалось измерить.', [page.path])); continue; }
    for (const [key, min] of Object.entries(rule.minScores) as Array<[BrowserScoreKey, number | null]>) {
      const score = page.scores[key];
      if (min !== null && (score === null || score < min)) reasons.push(tr('Страница {0}: «{1}» {2} из 100, нужно не меньше {3}.', [page.path, tr(scoreTitles[key]), score ?? '—', min]));
    }
    if (rule.maxLcpMs !== null && (page.metrics.lcpMs === null || page.metrics.lcpMs > rule.maxLcpMs)) reasons.push(tr('Страница {0}: главный блок появляется за {1} с, нужно не дольше {2} с.', [page.path, page.metrics.lcpMs === null ? '—' : (page.metrics.lcpMs / 1000).toFixed(1), (rule.maxLcpMs / 1000).toFixed(1)]));
    if (rule.maxCls !== null && (page.metrics.cls === null || page.metrics.cls > rule.maxCls)) reasons.push(tr('Страница {0}: содержимое сдвигается при загрузке ({1}), допустимо не больше {2}.', [page.path, page.metrics.cls ?? '—', rule.maxCls]));
  }
  if (!result?.pages.length) reasons.push(tr('Проверка в браузере не измерила ни одной страницы.'));
  return { status: reasons.length ? 'failed' : 'passed', reasons };
}

/** Throws unless the build meets the browser rule of its quality report (no rule: nothing to check). */
export async function assertBrowserGate(prisma: Pick<PrismaService, 'browserCheck'>, versionId: string, rule: BrowserRule | null | undefined): Promise<void> {
  if (!rule?.required) return;
  const check = await prisma.browserCheck.findUnique({ where: { versionId }, select: { status: true, result: true } });
  const gate = evaluateBrowserGate(rule, check);
  if (gate.status === 'pending') throw new ConflictException('BROWSER_CHECK_PENDING');
  if (gate.status === 'unavailable') throw new UnprocessableEntityException('BROWSER_CHECK_REQUIRED');
  if (gate.status === 'failed') throw new UnprocessableEntityException('BROWSER_GATE_FAILED');
}
