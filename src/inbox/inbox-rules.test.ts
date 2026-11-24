import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSee, displayName, kindOf, orderInbox, publicDetails, quote, type InboxItem } from './inbox-rules.js';

test('event types fall into kinds', () => {
  assert.equal(kindOf('stage_accepted'), 'stage');
  assert.equal(kindOf('stage_generated'), 'ai');
  assert.equal(kindOf('agent_task_finished'), 'ai');
  assert.equal(kindOf('change_notice_created'), 'changes');
  assert.equal(kindOf('specialist_joined'), 'team');
  assert.equal(kindOf('specialist_payment_started'), 'money');
  assert.equal(kindOf('time_approved'), 'money');
  assert.equal(kindOf('site_published'), 'site');
  assert.equal(kindOf('something_new'), 'other');
});

test('owners and managers see everything; other members never see money', () => {
  const event = { type: 'top_up_paid', stageKey: null };
  assert.equal(canSee({ kind: 'member', role: 'owner', stageKeys: [] }, event), true);
  assert.equal(canSee({ kind: 'member', role: 'manager', stageKeys: [] }, event), true);
  assert.equal(canSee({ kind: 'member', role: 'viewer', stageKeys: [] }, event), false);
  assert.equal(canSee({ kind: 'member', role: 'viewer', stageKeys: [] }, { type: 'stage_accepted', stageKey: 'goal' }), true);
});

test('a contributor limited to stages sees those stages and project-wide events', () => {
  const viewer = { kind: 'member' as const, role: 'contributor', stageKeys: ['content'] };
  assert.equal(canSee(viewer, { type: 'stage_accepted', stageKey: 'content' }), true);
  assert.equal(canSee(viewer, { type: 'stage_accepted', stageKey: 'goal' }), false);
  assert.equal(canSee(viewer, { type: 'site_published', stageKey: null }), true);
});

test('a specialist sees only their stages and the payments of their own work, never the wallet', () => {
  const viewer = { kind: 'specialist' as const, stageKeys: ['design'] };
  assert.equal(canSee(viewer, { type: 'stage_submitted', stageKey: 'design' }), true);
  assert.equal(canSee(viewer, { type: 'specialist_payment_started', stageKey: 'design' }), true);
  assert.equal(canSee(viewer, { type: 'stage_submitted', stageKey: 'goal' }), false);
  assert.equal(canSee(viewer, { type: 'site_published', stageKey: null }), false);
  assert.equal(canSee(viewer, { type: 'top_up_paid', stageKey: 'design' }), false);
});

test('only short scalar details leave the server', () => {
  assert.deepEqual(publicDetails({ versionNumber: 3, entryId: 'x', claim: 'secret text', role: 'lead', amount: '5 000 ₸', email: 'a@b.c' }), { versionNumber: 3, role: 'lead', amount: '5 000 ₸' });
  assert.deepEqual(publicDetails({ status: 'x'.repeat(200) }), {});
  assert.deepEqual(publicDetails(null), {});
  assert.deepEqual(publicDetails(['a']), {});
});

const item = (kind: InboxItem['kind'], since: string, dueAt: string | null = null): InboxItem =>
  ({ id: `${kind}-${since}`, kind, projectId: 'p', projectName: 'P', projectType: null, stageKey: null, since, dueAt, count: 1, who: null, text: null });

test('inbox order: overdue first, then deadlines, then urgency, then the oldest', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const ordered = orderInbox([
    item('mention', '2026-11-20T00:00:00Z'),
    item('stage_review', '2026-11-23T00:00:00Z'),
    item('stage_review', '2026-11-21T00:00:00Z'),
    item('change_notice', '2026-11-22T00:00:00Z', '2026-11-26T00:00:00Z'),
    item('change_notice', '2026-11-19T00:00:00Z', '2026-11-23T00:00:00Z'),
  ], now);
  assert.deepEqual(ordered.map((entry) => entry.id), [
    'change_notice-2026-11-19T00:00:00Z', 'change_notice-2026-11-22T00:00:00Z',
    'stage_review-2026-11-21T00:00:00Z', 'stage_review-2026-11-23T00:00:00Z', 'mention-2026-11-20T00:00:00Z',
  ]);
});

test('quotes are flattened and cut; people are shown by name only', () => {
  assert.equal(quote('  a\n\nb  '), 'a b');
  assert.equal(quote('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
  assert.equal(quote(null), null);
  assert.equal(displayName({ name: ' Айгерим ' }), 'Айгерим');
  assert.equal(displayName({ name: null }), null);
});
