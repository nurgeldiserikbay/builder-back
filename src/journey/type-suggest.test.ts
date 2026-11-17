import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../i18n/en.js';
import { projectTypes } from './catalog.js';
import { TYPE_QUESTIONS, hintAnswers, parseAnswers, suggestType } from './type-suggest.js';

const typeOf = (answers: Parameters<typeof suggestType>[0]) => { const result = suggestType(answers); return 'type' in result ? result.type : null; };

describe('«Расскажите о своём деле»: picking the project type', () => {
  it('a business need decides the type; an account area outranks booking, booking outranks a store', () => {
    assert.equal(typeOf({ appointments: true, accounts: false }), 'booking');
    assert.equal(typeOf({ products: true, accounts: false }), 'store');
    assert.equal(typeOf({ accounts: true }), 'web_app');
    const both = suggestType({ appointments: true, products: true, accounts: false });
    assert.ok('type' in both && both.type === 'booking' && both.alternatives.includes('store'));
  });

  it('without such needs the amount of information decides between one page, a company site and a multi-page site', () => {
    const none = { appointments: false, products: false, accounts: false } as const;
    assert.equal(typeOf({ ...none, size: 'one' }), 'landing');
    assert.equal(typeOf({ ...none, size: 'few' }), 'company_site');
    assert.equal(typeOf({ ...none, size: 'many' }), 'multipage');
  });

  it('asks what is still needed instead of guessing', () => {
    assert.deepEqual(suggestType({}), { missing: ['appointments', 'products', 'accounts'] });
    assert.deepEqual(suggestType({ appointments: true }), { missing: ['accounts'] });
    assert.deepEqual(suggestType({ appointments: false, products: false, accounts: false }), { missing: ['size'] });
  });

  it('the description hints answers, never a «no»', () => {
    assert.deepEqual(hintAnswers('Барбершоп в центре, мужские стрижки, клиенты записываются по телефону'), { appointments: true });
    assert.deepEqual(hintAnswers('Пеку торты на заказ, доставка по городу'), { products: true });
    assert.deepEqual(hintAnswers('Нужен личный кабинет ученика и учёт оплат'), { accounts: true });
    assert.deepEqual(hintAnswers('Массажный кабинет у дома'), { appointments: true });
    assert.deepEqual(hintAnswers('Юридические консультации для бизнеса'), { appointments: true });
    assert.deepEqual(hintAnswers('Ремонт квартир под ключ'), {});
  });

  it('answers are read leniently and unknown values are ignored', () => {
    assert.deepEqual(parseAnswers({ appointments: 'yes', products: false, accounts: 'maybe', size: 'huge' }), { appointments: true, products: false });
    assert.deepEqual(parseAnswers(null), {});
  });

  it('every type can be reached, and every text has an English translation', () => {
    const reached = new Set<string>();
    for (const appointments of [true, false]) for (const products of [true, false]) for (const accounts of [true, false]) for (const size of ['one', 'few', 'many'] as const) {
      const type = typeOf({ appointments, products, accounts, size });
      if (type) reached.add(type);
    }
    assert.deepEqual([...reached].sort(), Object.keys(projectTypes).sort());
    for (const question of TYPE_QUESTIONS) for (const text of [question.question, question.hint, ...question.options.map((option) => option.label)]) assert.ok(en[text], text);
    for (const type of Object.keys(projectTypes)) {
      const result = suggestType(type === 'web_app' ? { accounts: true } : type === 'booking' ? { appointments: true, accounts: false } : type === 'store' ? { products: true, accounts: false } : { appointments: false, products: false, accounts: false, size: type === 'landing' ? 'one' : type === 'company_site' ? 'few' : 'many' });
      assert.ok('reason' in result && en[result.reason], type);
    }
  });
});
