import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeAiOutput } from './ai-normalize.js';
import { ArtifactValidationError } from './artifacts.js';
import { normalizeScreens } from './webapp.js';

describe('AI output: repaired, not thrown away', () => {
  it('cuts over-long texts, drops extra items and items without a required field, and says what it repaired', () => {
    const logs: string[] = [];
    const block = { kind: 'list', title: 'Заявки', fields: ['Статус'] };
    const raw = { screens: [
      { key: 'orders', title: 'Список всех заявок клиентов сервиса с фильтрами по статусу, мастеру и дате', role: 'dispatcher', purpose: 'x'.repeat(500), features: [], blocks: Array.from({ length: 11 }, () => block), links: [] },
      { key: 'broken', title: '', role: 'client', blocks: [] },
      { key: 'mine', title: 'Мои заявки', role: 'master', blocks: [block], links: ['orders'] },
    ] };
    const result = normalizeAiOutput(raw, normalizeScreens, (message) => logs.push(message));
    assert.deepEqual(result.screens.map((screen) => screen.key), ['orders', 'mine']);
    assert.ok(result.screens[0]!.title.length <= 60 && result.screens[0]!.title.startsWith('Список всех заявок'));
    assert.ok(result.screens[0]!.purpose.length <= 300);
    assert.equal(result.screens[0]!.blocks.length, 8);
    assert.match(logs[0]!, /^AI output repaired: .*FIELD_TOO_LONG:screens\.#\.title/);
    assert.equal((raw.screens[0] as { title: string }).title.length > 60, true, 'the original answer is not changed');
  });
  it('still refuses what cannot be repaired, and logs why', () => {
    const logs: string[] = [];
    assert.throws(() => normalizeAiOutput({ screens: 'нет' }, normalizeScreens, (message) => logs.push(message)), ArtifactValidationError);
    assert.deepEqual(logs, ['AI output rejected: FIELD_INVALID:screens']);
  });
});
