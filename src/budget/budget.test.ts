import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costOf, estimateRoute, requestCost, tenge } from './budget.js';

const pricing = { inputPerMillionTiyn: 150_000, outputPerMillionTiyn: 600_000 }; // 1 500 ₸ and 6 000 ₸ per million tokens

describe('AI budget', () => {
  it('prices a request in tiyn, rounding up; unknown tokens or prices give no cost', () => {
    assert.equal(costOf({ inputTokens: 4000, outputTokens: 1500 }, pricing), 1500); // 600 + 900 tiyn = 15 ₸
    assert.equal(costOf({ inputTokens: 1, outputTokens: 0 }, pricing), 1);
    assert.equal(costOf({ inputTokens: null, outputTokens: null }, pricing), null);
    assert.equal(costOf({ inputTokens: 10, outputTokens: 10 }, null), null);
    assert.equal(tenge(requestCost({ input: 4000, output: 1500 }, pricing)), 15);
  });
  it('estimates the route as a range and leaves accepted stages out of the remaining part', () => {
    const estimate = estimateRoute([
      { key: 'goal', done: true, aiUsed: true }, { key: 'content', done: false, aiUsed: true },
      { key: 'design', done: false, aiUsed: true }, { key: 'build', done: false, aiUsed: false },
    ], { input: 4000, output: 1500 }, pricing);
    assert.deepEqual(estimate.total, { min: (2 + 3 + 1) * 1500, max: (5 + 10 + 3) * 1500 });
    assert.deepEqual(estimate.remaining, { min: (3 + 1) * 1500, max: (10 + 3) * 1500 });
    assert.deepEqual(estimate.perStage.find((stage) => stage.key === 'build')!.cost, { min: 0, max: 0 });
  });
});
