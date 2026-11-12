import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogScore, catalogStageKeys, checkProfile, checkReview, ratingSummary, reviewState } from './catalog-rules.js';

const base = { displayName: '  Айгерим  С. ', headline: 'Тексты для сайтов услуг', about: null, stageKeys: ['content'], hourlyRate: 5000, city: 'Алматы', published: true };

describe('specialist profile', () => {
  it('normalises text and converts the rate to tiyn', () => {
    const result = checkProfile(base);
    assert.ok(result.ok);
    assert.equal(result.value.displayName, 'Айгерим С.');
    assert.equal(result.value.hourlyRateTiyn, 500_000);
  });
  it('refuses stages without AI, unknown stages and a published card without stages', () => {
    assert.ok(!catalogStageKeys.includes('build'));
    assert.deepEqual(checkProfile({ ...base, stageKeys: ['build'] }), { ok: false, code: 'PROFILE_STAGE_INVALID' });
    assert.deepEqual(checkProfile({ ...base, stageKeys: [] }), { ok: false, code: 'PROFILE_STAGES_REQUIRED' });
    assert.ok(checkProfile({ ...base, stageKeys: [], published: false }).ok);
    assert.deepEqual(checkProfile({ ...base, hourlyRate: 0 }), { ok: false, code: 'PROFILE_RATE_INVALID' });
    assert.deepEqual(checkProfile({ ...base, headline: 'abc' }), { ok: false, code: 'PROFILE_HEADLINE_INVALID' });
  });
});

describe('specialist reviews', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  it('only after the stage was accepted, once per assignment, editable by the author for 14 days', () => {
    assert.equal(reviewState({ status: 'active', userId: 'u' }, null, 'o', now).allowed, false);
    assert.equal(reviewState({ status: 'completed', userId: null }, null, 'o', now).allowed, false);
    assert.deepEqual(reviewState({ status: 'completed', userId: 'u' }, null, 'o', now), { allowed: true, mode: 'create' });
    assert.deepEqual(reviewState({ status: 'completed', userId: 'u' }, { createdAt: new Date('2026-11-10T00:00:00Z'), authorUserId: 'o' }, 'o', now), { allowed: true, mode: 'update' });
    assert.equal(reviewState({ status: 'completed', userId: 'u' }, { createdAt: new Date('2026-11-01T00:00:00Z'), authorUserId: 'o' }, 'o', now).allowed, false);
    assert.equal(reviewState({ status: 'completed', userId: 'u' }, { createdAt: new Date('2026-11-19T00:00:00Z'), authorUserId: 'manager' }, 'o', now).allowed, false);
  });
  it('a low mark needs a comment', () => {
    assert.deepEqual(checkReview(2, '  '), { ok: false, code: 'REVIEW_TEXT_REQUIRED' });
    assert.deepEqual(checkReview(5, null), { ok: true, rating: 5, text: null });
    assert.deepEqual(checkReview(6, 'x'), { ok: false, code: 'REVIEW_RATING_INVALID' });
    assert.deepEqual(checkReview(3.5, 'x'), { ok: false, code: 'REVIEW_RATING_INVALID' });
  });
  it('sums up and orders: many good reviews beat a single five', () => {
    assert.deepEqual(ratingSummary(14, 3), { rating: 4.7, reviews: 3 });
    assert.deepEqual(ratingSummary(0, 0), { rating: null, reviews: 0 });
    assert.ok(catalogScore(4.8, 20, 20) > catalogScore(5, 1, 1));
    assert.ok(catalogScore(null, 0, 0) > catalogScore(3, 1, 1));
  });
});

describe('review moderation', () => {
  it('a complaint and a decision need a reason', async () => {
    const { checkReport, checkModeration } = await import('./catalog-rules.js');
    assert.deepEqual(checkReport('плохо'), { ok: false, code: 'REVIEW_REPORT_INVALID' });
    assert.deepEqual(checkReport('  Отзыв про другой проект, не про мою работу  '), { ok: true, reason: 'Отзыв про другой проект, не про мою работу' });
    assert.deepEqual(checkModeration('delete', 'Оскорбление'), { ok: false, code: 'MODERATION_DECISION_INVALID' });
    assert.deepEqual(checkModeration('hide', ''), { ok: false, code: 'MODERATION_NOTE_REQUIRED' });
    assert.deepEqual(checkModeration('keep', 'Отзыв по существу'), { ok: true, decision: 'keep', note: 'Отзыв по существу' });
  });
});
