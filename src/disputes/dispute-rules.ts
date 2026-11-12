// Rules of disputes between a project owner and a specialist. Staff decide; the platform only keeps the process fair and the money still.

export type Side = 'owner' | 'specialist';
export type Kind = 'payment' | 'refund' | 'quality' | 'other';
export type Outcome = 'specialist' | 'owner' | 'split' | 'no_change';

/** A specialist asks to be paid; an owner asks for money back or complains about the work. */
export const kindsBySide: Record<Side, Kind[]> = { specialist: ['payment', 'other'], owner: ['refund', 'quality', 'other'] };
export const outcomes: Outcome[] = ['specialist', 'owner', 'split', 'no_change'];
/** After access was revoked, the specialist can still open a dispute for this long. */
export const REVOKED_WINDOW_DAYS = 30;
export const MAX_MESSAGES = 50;
export const MAX_AMOUNT_TENGE = 100_000_000;

const clean = (value: unknown) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim() : '');

/** Which side the user is on for this assignment, or null when they have no say in it. */
export function sideOf(userId: string, assignment: { userId: string | null }, memberRole: string | null): Side | null {
  if (assignment.userId === userId) return 'specialist';
  if (memberRole === 'owner' || memberRole === 'manager') return 'owner';
  return null;
}

/** Whether a dispute may be opened now. An invitation not yet accepted has nothing to dispute. */
export function canOpen(assignment: { status: string; revokedAt: Date | null; acceptedAt: Date | null }, hasOpen: boolean, now = new Date()): { ok: true } | { ok: false; code: string } {
  if (hasOpen) return { ok: false, code: 'DISPUTE_ALREADY_OPEN' };
  if (!assignment.acceptedAt || assignment.status === 'invited') return { ok: false, code: 'DISPUTE_NOT_AVAILABLE' };
  if (assignment.status === 'revoked' && (!assignment.revokedAt || now.getTime() - assignment.revokedAt.getTime() > REVOKED_WINDOW_DAYS * 86_400_000)) return { ok: false, code: 'DISPUTE_WINDOW_CLOSED' };
  return { ok: true };
}

export function checkClaim(side: Side, input: { kind: unknown; claim: unknown; amount: unknown }): { ok: true; kind: Kind; claim: string; amountTiyn: number | null } | { ok: false; code: string } {
  if (typeof input.kind !== 'string' || !(kindsBySide[side] as string[]).includes(input.kind)) return { ok: false, code: 'DISPUTE_KIND_INVALID' };
  const claim = clean(input.claim);
  if (claim.length < 20 || claim.length > 2000) return { ok: false, code: 'DISPUTE_CLAIM_INVALID' };
  const amount = input.amount ?? null;
  if (amount !== null && (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > MAX_AMOUNT_TENGE)) return { ok: false, code: 'DISPUTE_AMOUNT_INVALID' };
  // Money claims need a figure so staff and the other side know what is asked.
  if ((input.kind === 'payment' || input.kind === 'refund') && amount === null) return { ok: false, code: 'DISPUTE_AMOUNT_REQUIRED' };
  return { ok: true, kind: input.kind as Kind, claim, amountTiyn: amount === null ? null : (amount as number) * 100 };
}

export function checkMessage(text: unknown, count: number): { ok: true; text: string } | { ok: false; code: string } {
  if (count >= MAX_MESSAGES) return { ok: false, code: 'DISPUTE_TOO_MANY_MESSAGES' };
  const value = clean(text);
  if (value.length < 2 || value.length > 2000) return { ok: false, code: 'DISPUTE_MESSAGE_INVALID' };
  return { ok: true, text: value };
}

/**
 * Staff decision. A payment to the specialist can be created only by a decision in their favour or a split; it is a
 * new amount due from the owner, not a transfer. Money already held for the specialist is returned to the owner
 * with the existing refund action, so the decision itself never moves money.
 */
export function checkResolution(input: { outcome: unknown; note: unknown; paySpecialist: unknown }): { ok: true; outcome: Outcome; note: string; payTiyn: number | null } | { ok: false; code: string } {
  if (typeof input.outcome !== 'string' || !(outcomes as string[]).includes(input.outcome)) return { ok: false, code: 'DISPUTE_OUTCOME_INVALID' };
  const note = clean(input.note);
  if (note.length < 10 || note.length > 1000) return { ok: false, code: 'DISPUTE_NOTE_REQUIRED' };
  const pay = input.paySpecialist ?? null;
  if (pay !== null) {
    if (input.outcome !== 'specialist' && input.outcome !== 'split') return { ok: false, code: 'DISPUTE_PAYMENT_NOT_ALLOWED' };
    if (!Number.isInteger(pay) || (pay as number) < 1 || (pay as number) > MAX_AMOUNT_TENGE) return { ok: false, code: 'DISPUTE_AMOUNT_INVALID' };
  }
  return { ok: true, outcome: input.outcome as Outcome, note, payTiyn: pay === null ? null : (pay as number) * 100 };
}
