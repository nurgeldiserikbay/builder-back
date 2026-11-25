import assert from 'node:assert/strict';
import { exec as execCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { CASES_COMMAND, parseCaseResults } from './agent-loop.js';
import { moduleInstruction } from './agent-tasks.js';
import type { Roadmap } from '../journey/roadmap.js';
import type { TestPlan } from '../journey/testplan.js';

const exec = promisify(execCallback);

describe('test-plan cases in the agent\'s tests', () => {
  it('reads each case from a real `node --test` TAP run: nested tests, a failing one, skip and todo prove nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cases-'));
    try {
      await writeFile(path.join(dir, 'rules.test.js'), [
        "import test, { describe } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('[case:c1] the client creates a request', () => assert.equal(1, 1));",
        "describe('rights', () => {",
        "  test('[case:c2] staff cannot delete', () => assert.equal(1, 2));",
        "  test('[case:c3] own records only', { skip: true }, () => {});",
        "  test('[case:c4] later', { todo: true }, () => { throw new Error('x'); });",
        '});',
        "test('[case:c5] first part', () => {});",
        "test('[case:c5] second part', () => { throw new Error('no'); });",
        "test('no case here', () => {});",
      ].join('\n'));
      await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
      // A clean environment, as in the sandbox: this runner's own test context must not leak into the child run.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST') && key !== 'NODE_OPTIONS'));
      const { stdout } = await exec(CASES_COMMAND, { cwd: dir, env }).catch((error: { stdout: string }) => ({ stdout: error.stdout }));
      assert.deepEqual(parseCaseResults(stdout), { c1: 'passed', c2: 'failed', c5: 'failed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a module task is described from the plan, the contracts and the test plan', () => {
    const roadmap = { hoursPerDay: 6, notes: '', risks: [], modules: [
      { key: 'setup', name: 'Каркас', summary: '', contractModule: null, dependsOn: [], executor: 'ai', tasks: [{ key: 's1', title: 'Репозиторий', feature: null, release: 1, hours: 2, aiRequests: 1 }] },
      { key: 'requests', name: 'Заявки', summary: 'Владеет данными: request', contractModule: 'm_request', dependsOn: ['setup'], executor: 'ai', tasks: [{ key: 'r1', title: 'Операции API', feature: null, release: 1, hours: 3, aiRequests: 2 }] },
    ] } as unknown as Roadmap;
    const testplan = { skipped: [], notes: '', cases: [
      { key: 'c7', task: 'r1', method: 'auto' }, { key: 'c8', task: 'r1', method: 'human' }, { key: 'c9', task: 's1', method: 'auto' },
    ] } as unknown as TestPlan;
    const text = moduleInstruction({ roadmap, module: 'requests', testplan, contracts: { modules: [], events: [], integrations: [], operations: [{ key: 'list', module: 'm_request', method: 'GET', path: '/api/request' }] } as never });
    assert.match(text, /Модуль «Заявки»/);
    assert.match(text, /Каркас/);
    assert.match(text, /GET \/api\/request/);
    assert.match(text, /c7/);
    assert.doesNotMatch(text, /c8|c9/);
  });
});
