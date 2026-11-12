import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter } from './rate-limit.js';

describe('rate limiter', () => {
  it('allows up to the limit within the window, then refuses', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const limit = { max: 2, windowMs: 1000 };
    limiter.take('login', 'A@x.kz', limit);
    limiter.take('login', 'a@x.kz ', limit); // same key after trim and lower case
    assert.throws(() => limiter.take('login', 'a@x.kz', limit), (error: { getStatus(): number }) => error.getStatus() === 429);
    now = 1001;
    assert.doesNotThrow(() => limiter.take('login', 'a@x.kz', limit));
  });

  it('keeps scopes and values apart and can be cleared', () => {
    const limiter = new RateLimiter(() => 0);
    const limit = { max: 1, windowMs: 1000 };
    limiter.hit('fail', 'a', limit);
    assert.equal(limiter.allowed('fail', 'a', limit), false);
    assert.equal(limiter.allowed('fail', 'b', limit), true);
    assert.equal(limiter.allowed('other', 'a', limit), true);
    limiter.clear('fail', 'a');
    assert.equal(limiter.allowed('fail', 'a', limit), true);
  });
});
