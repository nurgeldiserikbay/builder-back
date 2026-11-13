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

describe('portfolio', () => {
  it('keeps only links a visitor can open safely', async () => {
    const { portfolioUrl } = await import('./catalog-rules.js');
    assert.equal(portfolioUrl(' https://tort.kz/menu '), 'https://tort.kz/menu');
    assert.equal(portfolioUrl('javascript:alert(1)'), null);
    assert.equal(portfolioUrl('data:text/html,hi'), null);
    assert.equal(portfolioUrl('https://user:pass@tort.kz'), null);
    assert.equal(portfolioUrl('http://192.168.0.1/admin'), null);
    assert.equal(portfolioUrl('http://localhost:3000'), null);
    assert.equal(portfolioUrl('не ссылка'), null);
  });
  it('checks items, keeps their order and refuses too many or duplicates', async () => {
    const { checkPortfolio } = await import('./catalog-rules.js');
    const ok = checkPortfolio([{ title: ' Сайт кондитерской ', description: '', url: 'https://tort.kz', stageKey: 'content' }, { title: 'Меню кафе', description: 'Тексты и структура', url: null, stageKey: null }]);
    assert.deepEqual(ok, { ok: true, items: [{ title: 'Сайт кондитерской', description: null, url: 'https://tort.kz/', stageKey: 'content', photoId: null }, { title: 'Меню кафе', description: 'Тексты и структура', url: null, stageKey: null, photoId: null }] });
    // A photo must be one of the specialist's own.
    assert.deepEqual(checkPortfolio([{ title: 'Сайт', photoId: 'p1' }]), { ok: false, code: 'PORTFOLIO_PHOTO_INVALID:0' });
    assert.equal((checkPortfolio([{ title: 'Сайт', photoId: 'p1' }], new Set(['p1'])) as { items: { photoId: string }[] }).items[0].photoId, 'p1');
    assert.deepEqual(checkPortfolio([{ title: 'ab' }]), { ok: false, code: 'PORTFOLIO_TITLE_INVALID:0' });
    assert.deepEqual(checkPortfolio([{ title: 'Сайт', url: 'ftp://x.kz' }]), { ok: false, code: 'PORTFOLIO_URL_INVALID:0' });
    assert.deepEqual(checkPortfolio([{ title: 'Сайт', url: 'https://a.kz' }, { title: 'Ещё', url: 'https://a.kz/' }]), { ok: false, code: 'PORTFOLIO_URL_DUPLICATE:1' });
    assert.deepEqual(checkPortfolio([{ title: 'Сайт', stageKey: 'build' }]), { ok: false, code: 'PORTFOLIO_STAGE_INVALID:0' });
    assert.deepEqual(checkPortfolio(Array.from({ length: 13 }, (_, i) => ({ title: `Работа ${i}` }))), { ok: false, code: 'PORTFOLIO_TOO_MANY' });
    assert.deepEqual(checkPortfolio([{ title: 'Сайт', price: 1 }]), { ok: false, code: 'PORTFOLIO_INVALID:0' });
  });
});

describe('catalog search and complaints', () => {
  it('matches every word anywhere on the card, ignoring case and ё', async () => {
    const { matchesSearch, searchWords } = await import('./catalog-rules.js');
    const words = (q: string) => (searchWords(q) as { words: string[] }).words;
    assert.deepEqual(words('  Тексты, для  КАФЕ! '), ['тексты', 'для', 'кафе']);
    assert.deepEqual(words(''), []);
    assert.deepEqual(searchWords('а'.repeat(81)), { ok: false, code: 'CATALOG_QUERY_TOO_LONG' });
    assert.ok(matchesSearch('Айгерим. Тексты для сайтов услуг. Алматы', words('тексты алматы')));
    assert.ok(matchesSearch('Ёлочные игрушки', words('елочные')));
    assert.ok(!matchesSearch('Тексты для сайтов', words('тексты дизайн')));
    assert.ok(matchesSearch('что угодно', []));
  });

  it('checks a complaint: target, work, reason and an explanation', async () => {
    const { checkProfileReport, checkProfileDecision } = await import('./catalog-rules.js');
    assert.deepEqual(checkProfileReport({ target: 'work', workIndex: 1, reason: 'not_theirs', text: '  Это наш сайт,   мы его делали сами ' }, 2), { ok: true, target: 'work', workIndex: 1, reason: 'not_theirs', text: 'Это наш сайт, мы его делали сами' });
    assert.deepEqual(checkProfileReport({ target: 'work', workIndex: 2, reason: 'fake', text: 'Работы нет на сайте' }, 2), { ok: false, code: 'PROFILE_REPORT_WORK_INVALID' });
    assert.deepEqual(checkProfileReport({ target: 'card', reason: 'spam', text: 'Работы нет на сайте' }, 0), { ok: false, code: 'PROFILE_REPORT_REASON_INVALID' });
    assert.deepEqual(checkProfileReport({ target: 'card', reason: 'other', text: 'плохо' }, 0), { ok: false, code: 'PROFILE_REPORT_TEXT_INVALID' });
    assert.deepEqual(checkProfileReport({ target: 'card', workIndex: 0, reason: 'offensive', text: 'Оскорбления в тексте' }, 1), { ok: true, target: 'card', workIndex: null, reason: 'offensive', text: 'Оскорбления в тексте' });
    assert.deepEqual(checkProfileDecision('remove_work', 'Чужая работа', 'card'), { ok: false, code: 'MODERATION_DECISION_INVALID' });
    assert.deepEqual(checkProfileDecision('hide_card', 'ok', 'card'), { ok: false, code: 'MODERATION_NOTE_REQUIRED' });
    assert.equal((checkProfileDecision('dismiss', 'Ссылка рабочая', 'work') as { decision: string }).decision, 'dismiss');
  });
});
