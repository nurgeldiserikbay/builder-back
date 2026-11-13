import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvalState, approveBlocker, canManage, checkPolicy, readPolicy } from './team-rules.js';

const team = new Map([['o', 'owner'], ['m', 'manager'], ['c', 'contributor'], ['r1', 'reviewer'], ['r2', 'reviewer'], ['v', 'viewer']]);

describe('team rules', () => {
  it('the owner manages everyone, a manager only those below, nobody the owner', () => {
    assert.equal(canManage('owner', 'manager'), true);
    assert.equal(canManage('manager', 'reviewer'), true);
    assert.equal(canManage('manager', 'manager'), false);
    assert.equal(canManage('owner', 'owner'), false);
    assert.equal(canManage('contributor', 'viewer'), false);
  });

  it('checks a policy against the team', () => {
    assert.equal(checkPolicy({ mode: 'x', reviewers: ['r1'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team), 'POLICY_MODE_INVALID');
    assert.equal(checkPolicy({ mode: 'one', reviewers: [], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team), 'POLICY_REVIEWERS_COUNT');
    assert.equal(checkPolicy({ mode: 'one', reviewers: ['v'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team), 'POLICY_REVIEWER_NOT_MEMBER');
    assert.equal(checkPolicy({ mode: 'one', reviewers: ['stranger'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team), 'POLICY_REVIEWER_NOT_MEMBER');
    assert.equal(checkPolicy({ mode: 'quorum', reviewers: ['r1', 'r2'], quorum: 3, authorMayApprove: false, order: 'parallel' as const }, team), 'POLICY_QUORUM_INVALID');
    assert.deepEqual(checkPolicy({ mode: 'quorum', reviewers: ['r1', 'r2', 'r1', 'o'], quorum: 2, authorMayApprove: false, order: 'parallel' as const }, team), { mode: 'quorum', reviewers: ['r1', 'r2', 'o'], quorum: 2, authorMayApprove: false, order: 'parallel' });
    assert.equal(readPolicy({ mode: 'nope' }), null);
    assert.equal(readPolicy(null), null);
  });

  it('counts approvals by mode and ignores the author unless allowed', () => {
    const all = { mode: 'all' as const, reviewers: ['r1', 'r2', 'c'], quorum: null, authorMayApprove: false, order: 'parallel' as const };
    // The contributor wrote the version: they are not waited for and their approval does not count.
    let state = approvalState(all, team, ['c', 'r1'], 'c');
    assert.deepEqual([state.required, state.approvedBy, state.met, state.waitingFor], [2, ['r1'], false, ['r2']]);
    state = approvalState(all, team, ['r1', 'r2'], 'c');
    assert.equal(state.met, true);
    assert.equal(approveBlocker(all, team, 'c', 'c', []), 'AUTHOR_CANNOT_APPROVE');
    assert.equal(approveBlocker(all, team, 'v', 'c', []), 'NOT_A_REVIEWER');
    assert.equal(approveBlocker(all, team, 'r1', 'c', ['r1']), 'ALREADY_APPROVED');
    assert.equal(approveBlocker({ ...all, authorMayApprove: true }, team, 'c', 'c', []), null);
    assert.equal(approvalState({ mode: 'one', reviewers: ['r1', 'r2'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team, ['r2'], 'c').met, true);
    assert.equal(approvalState({ mode: 'quorum', reviewers: ['r1', 'r2', 'm'], quorum: 2, authorMayApprove: false, order: 'parallel' as const }, team, ['m'], 'c').met, false);
  });

  it('sequential review goes in the listed order, skipping the author', () => {
    const policy = { mode: 'all' as const, reviewers: ['c', 'r2', 'r1'], quorum: null, authorMayApprove: false, order: 'sequential' as const };
    assert.equal(approvalState(policy, team, [], 'c').next, 'r2');
    assert.equal(approveBlocker(policy, team, 'r1', 'c', []), 'NOT_YOUR_TURN');
    assert.equal(approveBlocker(policy, team, 'r2', 'c', []), null);
    assert.equal(approvalState(policy, team, ['r2'], 'c').next, 'r1');
    assert.equal(approveBlocker(policy, team, 'r1', 'c', ['r2']), null);
    assert.equal(approvalState(policy, team, ['r2', 'r1'], 'c').next, null);
    assert.equal(checkPolicy({ mode: 'one', reviewers: ['r1'], quorum: null, authorMayApprove: false, order: 'zigzag' }, team), 'POLICY_ORDER_INVALID');
  });

  it('a policy that the current team can no longer meet is reported, not silently relaxed', () => {
    const removed = new Map(team);
    removed.delete('r2');
    const state = approvalState({ mode: 'all', reviewers: ['r1', 'r2'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, removed, ['r1'], 'c');
    assert.equal(state.broken, true);
    assert.equal(state.met, false);
    // The only reviewer is the author and may not approve their own version.
    assert.equal(approvalState({ mode: 'one', reviewers: ['c'], quorum: null, authorMayApprove: false, order: 'parallel' as const }, team, [], 'c').broken, true);
  });
});
