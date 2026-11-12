import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canOpen, checkClaim, checkMessage, checkResolution, sideOf } from './dispute-rules.js';

const claim = 'Этап закрыли без приёмки, хотя тексты были сданы вовремя.';

describe('dispute rules', () => {
  it('knows the side: the specialist of the assignment, or an owner/manager of the project', () => {
    assert.equal(sideOf('s', { userId: 's' }, null), 'specialist');
    assert.equal(sideOf('o', { userId: 's' }, 'owner'), 'owner');
    assert.equal(sideOf('m', { userId: 's' }, 'manager'), 'owner');
    assert.equal(sideOf('x', { userId: 's' }, 'editor'), null);
    assert.equal(sideOf('x', { userId: 's' }, null), null);
  });
  it('opens only for accepted invitations, one at a time, and for 30 days after access was revoked', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    assert.deepEqual(canOpen({ status: 'invited', revokedAt: null, acceptedAt: null }, false, now), { ok: false, code: 'DISPUTE_NOT_AVAILABLE' });
    assert.deepEqual(canOpen({ status: 'active', revokedAt: null, acceptedAt: now }, true, now), { ok: false, code: 'DISPUTE_ALREADY_OPEN' });
    assert.deepEqual(canOpen({ status: 'completed', revokedAt: null, acceptedAt: now }, false, now), { ok: true });
    assert.deepEqual(canOpen({ status: 'revoked', revokedAt: new Date('2026-11-20T00:00:00Z'), acceptedAt: now }, false, now), { ok: true });
    assert.deepEqual(canOpen({ status: 'revoked', revokedAt: new Date('2026-10-20T00:00:00Z'), acceptedAt: now }, false, now), { ok: false, code: 'DISPUTE_WINDOW_CLOSED' });
  });
  it('lets each side raise only its own kinds and needs an amount for money claims', () => {
    assert.deepEqual(checkClaim('specialist', { kind: 'refund', claim, amount: 1000 }), { ok: false, code: 'DISPUTE_KIND_INVALID' });
    assert.deepEqual(checkClaim('owner', { kind: 'payment', claim, amount: 1000 }), { ok: false, code: 'DISPUTE_KIND_INVALID' });
    assert.deepEqual(checkClaim('specialist', { kind: 'payment', claim, amount: null }), { ok: false, code: 'DISPUTE_AMOUNT_REQUIRED' });
    assert.deepEqual(checkClaim('specialist', { kind: 'payment', claim: 'мало', amount: 1000 }), { ok: false, code: 'DISPUTE_CLAIM_INVALID' });
    assert.deepEqual(checkClaim('owner', { kind: 'quality', claim, amount: null }), { ok: true, kind: 'quality', claim, amountTiyn: null });
    assert.deepEqual(checkClaim('specialist', { kind: 'payment', claim, amount: 30000 }), { ok: true, kind: 'payment', claim, amountTiyn: 3_000_000 });
  });
  it('limits messages', () => {
    assert.deepEqual(checkMessage(' ок ', 0), { ok: true, text: 'ок' });
    assert.deepEqual(checkMessage('x', 0), { ok: false, code: 'DISPUTE_MESSAGE_INVALID' });
    assert.deepEqual(checkMessage('нормально', 50), { ok: false, code: 'DISPUTE_TOO_MANY_MESSAGES' });
  });
  it('a decision needs an explanation and creates a payment only in the specialist\'s favour or a split', () => {
    const note = 'Работа сдана по условиям, правки владельца вне объёма.';
    assert.deepEqual(checkResolution({ outcome: 'specialist', note: 'ок', paySpecialist: null }), { ok: false, code: 'DISPUTE_NOTE_REQUIRED' });
    assert.deepEqual(checkResolution({ outcome: 'owner', note, paySpecialist: 1000 }), { ok: false, code: 'DISPUTE_PAYMENT_NOT_ALLOWED' });
    assert.deepEqual(checkResolution({ outcome: 'split', note, paySpecialist: 15000 }), { ok: true, outcome: 'split', note, payTiyn: 1_500_000 });
    assert.deepEqual(checkResolution({ outcome: 'maybe', note, paySpecialist: null }), { ok: false, code: 'DISPUTE_OUTCOME_INVALID' });
  });
});
