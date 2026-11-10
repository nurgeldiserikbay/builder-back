// Money for AI usage: cost of one request and the estimate for a project route. Amounts are in tiyn (1 ₸ = 100 tiyn).
import type { StageKey } from '../journey/catalog.js';

export type Pricing = { inputPerMillionTiyn: number; outputPerMillionTiyn: number };
export type Usage = { inputTokens: number | null; outputTokens: number | null } | null;

/** Typical tokens of one stage request, used until the platform has enough history. */
export const DEFAULT_TOKENS = { input: 4000, output: 1500 };

/** How many AI requests a stage usually takes: a first draft plus a few revisions. */
export const EXPECTED_REQUESTS: Record<StageKey, [min: number, max: number]> = {
  goal: [2, 5], offer: [1, 4], schedule: [0, 0], content: [3, 10], design: [1, 3], build: [0, 0],
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
