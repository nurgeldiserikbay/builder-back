import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../i18n/en.js';
import { runWithLocale } from '../i18n/i18n.js';
import { projectTypes } from './catalog.js';
import { normalizeProcess, templateProcess, type BusinessProcess } from './process.js';
import { SITUATIONS, situationsFor } from './situations.js';
import { reviewStage } from './stage-review.js';

const base = (): BusinessProcess => templateProcess('booking', null);
const rule = (key: string, value: string) => SITUATIONS.find((item) => item.key === key)!.options.find((option) => option.value === value)!.rule;
const open = (process: BusinessProcess, type: string) => reviewStage('process', process, { projectType: type }).findings.filter((finding) => finding.code === 'PROCESS_SITUATION_OPEN');

describe('«Вы это учли?» situations', () => {
  it('the catalog is well formed: one typical answer, short rules, unique keys, an English translation for every text', () => {
    assert.equal(new Set(SITUATIONS.map((item) => item.key)).size, SITUATIONS.length);
    for (const situation of SITUATIONS) {
      assert.equal(situation.options.filter((option) => option.typical).length, 1, situation.key);
      assert.ok(situation.types.length > 0 && situation.types.every((type) => type in projectTypes), situation.key);
      assert.notEqual(new Set(situation.options.map((option) => option.value)).size, 0);
      for (const text of [situation.question, situation.why, ...situation.options.flatMap((option) => [option.label, option.rule])]) {
        assert.ok(en[text], `no English for «${text}»`);
      }
      for (const option of situation.options) {
        assert.ok(option.rule.length <= 200 && en[option.rule]!.length <= 200, option.rule);
        assert.ok(!['custom', 'later'].includes(option.value));
      }
    }
  });

  it('every project type has questions to ask', () => {
    for (const type of Object.keys(projectTypes)) assert.ok(situationsFor(type).length >= 2, type);
  });

  it('an answer becomes a rule of the process after the owner\'s own rules', () => {
    const next = normalizeProcess({ ...base(), rules: ['Свой порядок'], situations: [{ key: 'no_show', answer: 'prepay' }] });
    assert.deepEqual(next.rules, ['Свой порядок', rule('no_show', 'prepay')]);
    assert.deepEqual(next.situations, [{ key: 'no_show', answer: 'prepay', rule: rule('no_show', 'prepay') }]);
  });

  it('changing the answer replaces its rule, and saving the result again changes nothing', () => {
    const first = normalizeProcess({ ...base(), rules: [], situations: [{ key: 'no_show', answer: 'prepay' }] });
    const changed = normalizeProcess({ ...first, situations: [{ ...first.situations![0], answer: 'nothing' }] });
    assert.deepEqual(changed.rules, [rule('no_show', 'nothing')]);
    assert.deepEqual(normalizeProcess(changed), changed);
  });

  it('an own answer is kept as written and replaced when rewritten; «later» adds no rule', () => {
    const custom = normalizeProcess({ ...base(), rules: [], situations: [{ key: 'late', answer: 'custom', custom: 'Опоздал — ждём 5 минут' }, { key: 'reminder', answer: 'later' }] });
    assert.deepEqual(custom.rules, ['Опоздал — ждём 5 минут']);
    const rewritten = normalizeProcess({ ...custom, situations: [{ ...custom.situations![0], custom: 'Опоздал — ждём 10 минут' }, custom.situations![1]] });
    assert.deepEqual(rewritten.rules, ['Опоздал — ждём 10 минут']);
    assert.throws(() => normalizeProcess({ ...base(), situations: [{ key: 'late', answer: 'custom', custom: '' }] }), /FIELD_REQUIRED:situations/);
  });

  it('unknown answers are refused, unknown questions are dropped', () => {
    assert.throws(() => normalizeProcess({ ...base(), situations: [{ key: 'no_show', answer: 'pay_double' }] }), /FIELD_INVALID:situations/);
    assert.equal(normalizeProcess({ ...base(), situations: [{ key: 'gone_question', answer: 'x' }] }).situations, undefined);
  });

  it('a rule an AI rewrite copied into rules is not duplicated', () => {
    const answered = normalizeProcess({ ...base(), rules: [], situations: [{ key: 'reminder', answer: 'day_before' }] });
    const fromAi = normalizeProcess({ ...answered, rules: [rule('reminder', 'day_before'), 'Новое правило'] });
    assert.deepEqual(fromAi.rules, ['Новое правило', rule('reminder', 'day_before')]);
  });

  it('rules are written in the project language and keep it whatever language saves them later', () => {
    const english = runWithLocale('en', () => normalizeProcess({ ...base(), rules: [], situations: [{ key: 'reminder', answer: 'day_before' }] }));
    assert.deepEqual(english.rules, [en[rule('reminder', 'day_before')]]);
    assert.deepEqual(runWithLocale('ru', () => normalizeProcess(english)), english);
  });

  it('the review asks every open question with its level; «later» softens all but blocking ones', () => {
    const none = open(base(), 'booking');
    assert.equal(none.length, situationsFor('booking').length);
    assert.ok(none.every((finding) => finding.ownerDecides));
    assert.equal(none.find((finding) => finding.target === 'situation:booking_cancel')?.severity, 'blocking');
    const later = normalizeProcess({ ...base(), situations: [{ key: 'booking_cancel', answer: 'later' }, { key: 'no_show', answer: 'later' }] });
    const findings = open(later, 'booking');
    assert.equal(findings.find((finding) => finding.target === 'situation:booking_cancel')?.severity, 'blocking');
    assert.equal(findings.find((finding) => finding.target === 'situation:no_show')?.severity, 'minor');
  });

  it('answered questions leave the review, and questions of other project types are not asked', () => {
    const answered = normalizeProcess({ ...base(), situations: situationsFor('booking').map((item) => ({ key: item.key, answer: item.options[0]!.value })) });
    assert.deepEqual(open(answered, 'booking'), []);
    assert.ok(open(base(), 'store').every((finding) => situationsFor('store').some((item) => `situation:${item.key}` === finding.target)));
    assert.deepEqual(open(base(), 'unknown'), []);
  });
});
