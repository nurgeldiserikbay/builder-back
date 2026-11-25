// Money for AI usage: cost of one request and the estimate for a project route. Amounts are in tiyn (1 ₸ = 100 tiyn).
import { routeAncestors, stageDefinitions, type StageKey } from '../journey/catalog.js';

export type Pricing = { inputPerMillionTiyn: number; outputPerMillionTiyn: number };
export type Usage = { inputTokens: number | null; outputTokens: number | null } | null;

/** Typical tokens of one stage request, used until the platform has enough history. */
export const DEFAULT_TOKENS = { input: 4000, output: 1500 };

/** How many AI requests a stage usually takes: a first draft plus a few revisions. */
export const EXPECTED_REQUESTS: Record<StageKey, [min: number, max: number]> = {
  goal: [2, 5], idea: [1, 4], process: [1, 4], suggestions: [1, 3], concept: [1, 3], offer: [1, 4], products: [0, 0], sitemap: [1, 3], schedule: [0, 0], features: [1, 4], screens: [1, 4], techplan: [0, 0], contracts: [0, 0], roadmap: [0, 0], testplan: [0, 0], content: [3, 10], design: [1, 3], build: [0, 0], handoff: [0, 0],
};

export function costOf(usage: Usage, pricing: Pricing | null): number | null {
  if (!pricing || !usage || (usage.inputTokens === null && usage.outputTokens === null)) return null;
  return Math.ceil(((usage.inputTokens ?? 0) * pricing.inputPerMillionTiyn + (usage.outputTokens ?? 0) * pricing.outputPerMillionTiyn) / 1_000_000);
}

export function requestCost(tokens: { input: number; output: number }, pricing: Pricing): number {
  return costOf({ inputTokens: tokens.input, outputTokens: tokens.output }, pricing) ?? 0;
}

/** Range for the remaining stages; accepted stages are not counted again. */
export function estimateRoute(stages: Array<{ key: StageKey; done: boolean; aiUsed: boolean }>, tokens: { input: number; output: number }, pricing: Pricing) {
  const perRequest = requestCost(tokens, pricing);
  const perStage = stages.map((stage) => {
    const [min, max] = stage.aiUsed ? EXPECTED_REQUESTS[stage.key] : [0, 0];
    return { key: stage.key, done: stage.done, requests: { min, max }, cost: { min: min * perRequest, max: max * perRequest } };
  });
  const sum = (pick: (item: (typeof perStage)[number]) => number) => perStage.reduce((total, item) => total + pick(item), 0);
  const remaining = perStage.filter((item) => !item.done);
  return {
    perRequest,
    total: { min: sum((item) => item.cost.min), max: sum((item) => item.cost.max) },
    remaining: { min: remaining.reduce((t, i) => t + i.cost.min, 0), max: remaining.reduce((t, i) => t + i.cost.max, 0) },
    perStage,
  };
}

export const tenge = (tiyn: number) => Math.round(tiyn) / 100;

/** Share of the cap after which the owner is warned. */
export const LIMIT_WARN_SHARE = 0.8;
export const MAX_LIMIT_TENGE = 10_000_000;

/**
 * Owner's cap on AI spending. A request may start only if what is spent plus a typical request still fits:
 * a request already running is never cut off, so the cap can be passed by at most one answer.
 */
export function spendLimitState(spentTiyn: number, limitTiyn: number | null, typicalTiyn: number) {
  if (limitTiyn === null) return { limitTiyn: null, leftTiyn: null, share: null, warn: false, blocked: false };
  const leftTiyn = Math.max(0, limitTiyn - spentTiyn);
  const share = limitTiyn > 0 ? spentTiyn / limitTiyn : 1;
  return { limitTiyn, leftTiyn, share, warn: share >= LIMIT_WARN_SHARE, blocked: spentTiyn + typicalTiyn > limitTiyn };
}

/**
 * The route of a project that does not exist yet, as estimateRoute expects it: stages before the chosen start are
 * brought by the owner (imported), so the AI does not work on them.
 */
export function plannedRoute(route: StageKey[], startStageKey: StageKey | null): Array<{ key: StageKey; done: boolean; aiUsed: boolean }> {
  const before = startStageKey ? new Set(routeAncestors(route, startStageKey)) : new Set<StageKey>();
  return route.map((key) => ({ key, done: before.has(key), aiUsed: stageDefinitions[key].ai.level !== 'none' }));
}

/** How many AI requests the stages still to do usually take. */
export function requestRange(route: Array<{ key: StageKey; done: boolean; aiUsed: boolean }>): { min: number; max: number } {
  return route.filter((stage) => !stage.done && stage.aiUsed).reduce((sum, stage) => ({ min: sum.min + EXPECTED_REQUESTS[stage.key][0], max: sum.max + EXPECTED_REQUESTS[stage.key][1] }), { min: 0, max: 0 });
}
