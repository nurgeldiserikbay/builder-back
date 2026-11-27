import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeProposal } from './artifacts.js';
import { withHonestSupport, EFFORT_HOURS, estimateFirstVersion, estimateSuggestion, estimateText, normalizeSuggestions, suggestionsMarkdown, type Suggestion } from './suggestions.js';

const item = (key: string, effort: Suggestion['effort'], support: Suggestion['support'], decision: Suggestion['decision']): Suggestion => ({
  key, title: key, value: 'Польза', basis: '', source: 'owner', catalogKey: null, support, effort, decision, reason: decision === 'now' ? '' : 'потом',
});

describe('time and price of the suggestions: a rough estimate by the kind of work', () => {
  it('hours and working days by effort; the price only with the owner\'s rate', () => {
    assert.deepEqual(EFFORT_HOURS, { small: [2, 6], medium: [6, 16], large: [16, 40] });
    assert.deepEqual(estimateSuggestion({ effort: 'medium', support: 'code' }, null), { hours: [6, 16], days: [1, 3], price: null, byPlatform: false, serviceFee: false });
    assert.deepEqual(estimateSuggestion({ effort: 'large', support: 'account' }, 5000), { hours: [16, 40], days: [3, 7], price: [80000, 200000], byPlatform: false, serviceFee: true });
    // What the platform makes on the site takes no developer.
    assert.deepEqual(estimateSuggestion({ effort: 'large', support: 'site' }, 5000), { hours: [0, 0], days: [0, 0], price: [0, 0], byPlatform: true, serviceFee: false });
    assert.equal(estimateText(estimateSuggestion({ effort: 'small', support: 'site' }, null)), 'делает платформа, без разработчика');
    assert.equal(estimateText(estimateSuggestion({ effort: 'large', support: 'account' }, 5000)), '≈ 16–40 ч · 3–7 раб. дн. · 80 000 ₸–200 000 ₸ · плюс плата сервиса по его тарифу');
    assert.equal(estimateText({ hours: [2, 6], days: [1, 1], price: null }), '≈ 2–6 ч · 1 раб. дн.');
  });

  it('the first version sums what goes «В первую версию»; the rate is checked, kept in Markdown and through redrafts', () => {
    const value = normalizeSuggestions({ rate: 4000, items: [item('a', 'small', 'code', 'now'), item('b', 'medium', 'account', 'now'), item('c', 'large', 'code', 'later'), item('d', 'large', 'site', 'now'), item('e', 'small', 'code', 'no')] });
    assert.equal(value.rate, 4000);
    assert.deepEqual(estimateFirstVersion(value), { items: 3, hours: [8, 22], days: [2, 4], price: [32000, 88000], serviceFees: 1 });
    assert.equal(estimateFirstVersion({ items: value.items }).price, null);
    assert.equal('rate' in normalizeSuggestions({ items: [] }), false);
    assert.equal(normalizeSuggestions({ items: [], rate: '' }).rate, undefined);
    assert.throws(() => normalizeSuggestions({ items: [], rate: -1 }), /FIELD_INVALID:rate/);
    assert.throws(() => normalizeSuggestions({ items: [], rate: 12.5 }), /FIELD_INVALID:rate/);
    const markdown = suggestionsMarkdown(value);
    assert.match(markdown, /\*\*a\*\* — Польза\. Оценка: ≈ 2–6 ч · 1 раб\. дн\. · 8 000 ₸–24 000 ₸/);
    assert.doesNotMatch(markdown, /\*\*e\*\*[^\n]*Оценка/, '«Не нужно» is not estimated');
    assert.match(markdown, /Первая версия, оценка по типу работы \(не смета\): ≈ 8–22 ч · 2–4 раб\. дн\. · 32 000 ₸–88 000 ₸ · плюс плата сервисов по их тарифам \(1\)/);
    // Saving runs the honest-support pass: the rate stays.
    assert.equal(withHonestSupport(value, 'booking').rate, 4000);
    const redraft = mergeProposal('suggestions', value, { items: [item('x', 'small', 'code', '')] }, [], null) as { rate?: number };
    assert.equal(redraft.rate, 4000);
  });
});
