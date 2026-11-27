import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectTypes } from './catalog.js';
import { phasesOf } from './phases.js';
import { launchIssues, launchItems, normalizeLaunch, type LaunchFacts } from './launch.js';
import type { AppFeatures } from './webapp.js';

const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  readiness: { blocking: { total: 4, passed: 4 }, scenarios: { total: 3, works: 3 }, openRemarks: 0 },
  deployment: { url: 'https://app.example.com', ok: true, database: 'postgres', checkedAt: '2026-11-25T00:00:00Z' },
  features: { sensitivity: 'personal' } as AppFeatures, idea: null, design: null, ...over,
});
const allDone = normalizeLaunch({ items: ['domain', 'legal', 'email', 'backups', 'monitoring', 'migration', 'analytics', 'audit'].map((key) => ({ key, status: 'done' })) });

describe('launch of a web application', () => {
  it('is the last stage of the route and has its own phase', () => {
    assert.equal(projectTypes.web_app.stages.at(-1), 'launch');
    const phases = phasesOf(projectTypes.web_app.stages.map((key) => ({ key, done: key !== 'launch' })), { applies: false, live: false });
    assert.deepEqual(phases.find((phase) => phase.key === 'launch')!.stageKeys, ['launch']);
    assert.equal(phases.find((phase) => phase.key === 'launch')!.status, 'current');
  });

  it('nothing open when the tests, the deployment and every item are done', () => {
    assert.deepEqual(launchIssues(allDone, facts()), []);
  });

  it('blocks on the test plan and the deployment; required items cannot be «not needed»', () => {
    const codes = (over: Partial<LaunchFacts>, value = allDone) => launchIssues(value, facts(over)).map((issue) => `${issue.severity}:${issue.code}`);
    assert.deepEqual(codes({ readiness: { blocking: { total: 4, passed: 3 }, scenarios: { total: 3, works: 2 }, openRemarks: 1 } }), ['blocking:LAUNCH_TESTS_NOT_PASSED', 'blocking:LAUNCH_SCENARIOS_NOT_ACCEPTED', 'blocking:LAUNCH_OPEN_REMARKS']);
    assert.deepEqual(codes({ readiness: null }), ['blocking:LAUNCH_NO_TESTPLAN']);
    assert.deepEqual(codes({ deployment: null }), ['blocking:LAUNCH_NOT_DEPLOYED']);
    assert.deepEqual(codes({ deployment: { url: 'http://app.example.com', ok: true, database: 'memory', checkedAt: '' } }), ['blocking:LAUNCH_NO_HTTPS', 'blocking:LAUNCH_MEMORY_DATABASE']);
    const partly = normalizeLaunch({ items: allDone.items.map((item) => (item.key === 'legal' ? { ...item, status: 'not_needed', note: 'потом' } : item.key === 'domain' ? { ...item, status: 'not_needed' } : item.key === 'audit' ? { ...item, status: 'todo' } : item)) });
    assert.deepEqual(codes({}, partly), ['minor:LAUNCH_ITEM_NO_REASON', 'important:LAUNCH_ITEM_REQUIRED', 'minor:LAUNCH_ITEM_OPEN', 'minor:LAUNCH_NO_AUDIT']);
    // Known vulnerabilities of the code to launch block; an audit that could not run is said so; a clean one says nothing.
    const vulnerable = launchIssues(allDone, facts({ audit: { state: 'vulnerable', taskId: 't', critical: 1, high: 2, packages: ['express', 'qs'] } }));
    assert.deepEqual(vulnerable.map((issue) => `${issue.severity}:${issue.code}`), ['blocking:LAUNCH_VULNERABLE_PACKAGES']);
    assert.match(vulnerable[0]!.message, /критических 1, высоких 2 \(express, qs\)/);
    assert.deepEqual(codes({ audit: { state: 'unchecked', taskId: 't' } }), ['important:LAUNCH_PACKAGES_NOT_CHECKED']);
    assert.deepEqual(codes({ audit: { state: 'clean', taskId: 't' } }), []);
    // Without personal data or money, legal texts and the audit are not demanded.
    assert.equal(launchItems(facts({ features: { sensitivity: 'normal' } as AppFeatures })).find((item) => item.key === 'legal')!.required, false);
  });
});
