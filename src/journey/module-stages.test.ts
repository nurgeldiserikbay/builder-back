import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { definitionOf, isModuleStageKey, isStageKey, moduleKeyOf, moduleStageKey, routeDependents, routeInputs, type StageKey } from './catalog.js';
import { projectRoute } from './journey-core.js';
import { moduleIssues, normalizeModuleWork, type ModuleFacts } from './module-stages.js';
import { phaseOf } from './phases.js';

const appStages: StageKey[] = ['goal', 'idea', 'process', 'suggestions', 'concept', 'features', 'screens', 'techplan', 'contracts', 'roadmap', 'testplan', 'handoff', 'launch'];
const rows = (keys: string[]) => keys.map((stageKey, position) => ({ stageKey, position: stageKey.startsWith('m_') ? 100 + position : position }));

describe('module stages', () => {
  it('knows module keys and gives them one definition', () => {
    assert.equal(moduleStageKey('accounts'), 'm_accounts');
    assert.equal(moduleKeyOf('m_accounts'), 'accounts');
    assert.ok(isModuleStageKey('m_order_items2') && !isModuleStageKey('m_') && !isModuleStageKey('m_Bad') && !isModuleStageKey('roadmap'));
    assert.ok(isStageKey('m_accounts') && isStageKey('roadmap') && !isStageKey('nope'));
    assert.equal(definitionOf('m_accounts').artifactType, 'module');
    assert.equal(phaseOf('m_accounts'), 'build');
  });

  it('puts module stages after the developer package, in plan order; a change of contracts or the plan reaches them', () => {
    const route = projectRoute(appStages, rows([...appStages, 'm_setup', 'm_accounts']));
    assert.deepEqual(route.slice(-4), ['handoff', 'm_setup', 'm_accounts', 'launch']);
    assert.deepEqual(routeInputs(route, 'm_setup'), ['contracts', 'roadmap', 'testplan']);
    for (const key of ['contracts', 'roadmap', 'testplan'] as StageKey[]) assert.ok(routeDependents(route, key).includes('m_accounts'), key);
    // Without module stages the route is the type's own.
    assert.deepEqual(projectRoute(appStages, rows(appStages)), appStages);
  });

  it('keeps the lead\'s words only and checks their length', () => {
    assert.deepEqual(normalizeModuleWork({ summary: '  Сделано  ', extra: 1 }), { summary: 'Сделано' });
    assert.throws(() => normalizeModuleWork({ summary: 'x'.repeat(2001) }), /FIELD_TOO_LONG:summary/);
  });

  it('accepts a module only by its cases and the platform\'s checks', () => {
    const base: ModuleFacts = {
      moduleKey: 'accounts', inPlan: true, agent: null,
      tasks: [{ key: 'a1', title: 'Вход', status: 'in_progress', cases: 1, passed: 0, failed: 1, fromCase: null }, { key: 'a2', title: 'Выход', status: 'not_started', cases: 0, passed: 0, failed: 0, fromCase: null }],
      cases: [{ key: 'c1', title: 'Вход по паролю', task: 'a1', method: 'auto', status: 'failed', stale: false }],
    };
    const codes = (facts: ModuleFacts) => moduleIssues(facts).map((issue) => `${issue.severity}:${issue.code}`);
    assert.deepEqual(codes(base), ['blocking:MODULE_TASKS_OPEN', 'blocking:MODULE_CASES_FAILED', 'important:MODULE_NOT_BUILT', 'minor:MODULE_TASK_WITHOUT_CASES']);
    const built: ModuleFacts = { ...base, agent: { taskId: 't', status: 'succeeded', checksFailed: 1 }, tasks: base.tasks.map((task) => ({ ...task, status: 'done', failed: 0, cases: 1 })), cases: [{ ...base.cases[0]!, status: 'passed' }] };
    assert.deepEqual(codes(built), ['blocking:MODULE_CHECKS_FAILED']);
    assert.deepEqual(codes({ ...built, agent: { taskId: 't', status: 'succeeded', checksFailed: 0 } }), []);
    assert.ok(codes({ ...built, inPlan: false }).includes('blocking:MODULE_NOT_IN_PLAN'));
  });
});
