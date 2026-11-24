import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOverview } from './projects.service.js';

const at = (day: number) => new Date(Date.UTC(2026, 10, day));

test('overview counts accepted stages, the stage in work and what waits for a decision', () => {
  const overview = projectOverview([
    { stageKey: 'goal', status: 'approved', updatedAt: at(1) },
    { stageKey: 'process', status: 'imported', updatedAt: at(2) },
    { stageKey: 'spec', status: 'in_review', updatedAt: at(5) },
    { stageKey: 'content', status: 'locked', updatedAt: at(3) },
  ], null, { members: 1, assignments: 2, changeNotices: 1 });
  assert.equal(overview.stagesTotal, 4);
  assert.equal(overview.stagesAccepted, 2);
  assert.deepEqual(overview.currentStage, { key: 'spec', status: 'in_review' });
  assert.equal(overview.waiting, 2);
  assert.equal(overview.people, 3);
  assert.equal(overview.publication, null);
  assert.deepEqual(overview.lastActivityAt, at(5));
});

test('a finished route has no current stage and reports the publication', () => {
  const overview = projectOverview([{ stageKey: 'goal', status: 'approved', updatedAt: at(1) }],
    { slug: 'barber', status: 'live', monitorStatus: 'up' }, { members: 1, assignments: 0, changeNotices: 0 });
  assert.equal(overview.currentStage, null);
  assert.deepEqual(overview.publication, { slug: 'barber', status: 'live', monitor: 'up' });
});
