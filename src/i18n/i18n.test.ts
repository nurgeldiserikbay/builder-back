import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localeFromHeader, localizeDeep, runWithLocale, tr } from './i18n.js';

describe('Interface language', () => {
  it('reads the language of the request', () => {
    assert.equal(localeFromHeader('en'), 'en');
    assert.equal(localeFromHeader('en-GB,en;q=0.9'), 'en');
    assert.equal(localeFromHeader('ru'), 'ru');
    assert.equal(localeFromHeader(undefined), 'ru');
  });
  it('translates platform texts with values and keeps Russian for Russian requests', () => {
    assert.equal(runWithLocale('en', () => tr('Начните этап «{0}». {1}', ['Цель сайта', 'x'])), 'Start the stage «Цель сайта». x');
    assert.equal(runWithLocale('ru', () => tr('Начните этап «{0}». {1}', ['Цель', 'x'])), 'Начните этап «Цель». x');
    assert.equal(tr('Готово'), 'Готово');
  });
  it('never translates project content inside responses', () => {
    const response = { data: { stage: { title: 'Цель сайта', statusLabel: 'Принят' }, current: { content: { title: 'Цель сайта', items: ['Готово'] } } } };
    const english = localizeDeep(response, 'en');
    assert.equal(english.data.stage.title, 'Site goal');
    assert.equal(english.data.stage.statusLabel, 'Accepted');
    assert.deepEqual(english.data.current.content, { title: 'Цель сайта', items: ['Готово'] });
    assert.equal(localizeDeep(response, 'ru'), response);
  });
});
