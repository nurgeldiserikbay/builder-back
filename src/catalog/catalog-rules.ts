// Rules of the specialist catalog: what a profile may contain, when an owner may review, how ratings are summed up.
import { stageDefinitions, type StageKey } from '../journey/catalog.js';

/** Stages where a specialist directs the AI; the others are forms without AI and need no specialist. */
export const catalogStageKeys = (Object.keys(stageDefinitions) as StageKey[]).filter((key) => stageDefinitions[key].ai.level !== 'none');

/** An owner may change a review for this long after writing it. */
export const REVIEW_EDIT_DAYS = 14;
export const MAX_RATE_TENGE = 1_000_000;

export interface ProfileInput { displayName: string; headline: string; about: string | null; stageKeys: string[]; hourlyRate: number | null; city: string | null; published: boolean }

const clean = (value: string | null) => {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text.length ? text : null;
};

/** Normalised profile or the code of the first problem. */
export function checkProfile(input: ProfileInput): { ok: true; value: Omit<ProfileInput, 'hourlyRate'> & { hourlyRateTiyn: number | null } } | { ok: false; code: string } {
  const displayName = clean(input.displayName);
  const headline = clean(input.headline);
  const about = input.about?.trim() ? input.about.trim() : null;
  if (!displayName || displayName.length < 2 || displayName.length > 80) return { ok: false, code: 'PROFILE_NAME_INVALID' };
  if (!headline || headline.length < 5 || headline.length > 140) return { ok: false, code: 'PROFILE_HEADLINE_INVALID' };
  if (about && about.length > 2000) return { ok: false, code: 'PROFILE_ABOUT_TOO_LONG' };
  const stageKeys = [...new Set(input.stageKeys)];
  if (stageKeys.some((key) => !(catalogStageKeys as string[]).includes(key))) return { ok: false, code: 'PROFILE_STAGE_INVALID' };
  // A published card must say what the person does, otherwise the catalog filter cannot find it.
  if (input.published && stageKeys.length === 0) return { ok: false, code: 'PROFILE_STAGES_REQUIRED' };
  if (input.hourlyRate !== null && (!Number.isInteger(input.hourlyRate) || input.hourlyRate < 1 || input.hourlyRate > MAX_RATE_TENGE)) return { ok: false, code: 'PROFILE_RATE_INVALID' };
  const city = clean(input.city);
  if (city && city.length > 80) return { ok: false, code: 'PROFILE_CITY_INVALID' };
  return { ok: true, value: { displayName, headline, about, stageKeys, hourlyRateTiyn: input.hourlyRate === null ? null : input.hourlyRate * 100, city, published: input.published } };
}

/** Only accepted work is reviewed: the stage was accepted while the specialist was on it. */
export function reviewState(assignment: { status: string; userId: string | null }, review: { createdAt: Date; authorUserId: string } | null, authorUserId: string, now = new Date()) {
  if (assignment.status !== 'completed' || !assignment.userId) return { allowed: false, code: 'REVIEW_NOT_AVAILABLE' } as const;
  if (!review) return { allowed: true, mode: 'create' } as const;
  if (review.authorUserId !== authorUserId) return { allowed: false, code: 'REVIEW_ALREADY_EXISTS' } as const;
  if (now.getTime() - review.createdAt.getTime() > REVIEW_EDIT_DAYS * 86_400_000) return { allowed: false, code: 'REVIEW_EDIT_EXPIRED' } as const;
  return { allowed: true, mode: 'update' } as const;
}

export function checkReview(rating: unknown, text: unknown): { ok: true; rating: number; text: string | null } | { ok: false; code: string } {
  if (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5) return { ok: false, code: 'REVIEW_RATING_INVALID' };
  if (text !== null && text !== undefined && typeof text !== 'string') return { ok: false, code: 'REVIEW_TEXT_INVALID' };
  const value = typeof text === 'string' && text.trim() ? text.trim() : null;
  if (value && value.length > 1000) return { ok: false, code: 'REVIEW_TEXT_INVALID' };
  // A low mark without a word does not help the next owner or the specialist.
  if ((rating as number) <= 2 && !value) return { ok: false, code: 'REVIEW_TEXT_REQUIRED' };
  return { ok: true, rating: rating as number, text: value };
}

/** Average to one decimal; null without reviews. */
export function ratingSummary(sum: number, count: number): { rating: number | null; reviews: number } {
  return { rating: count ? Math.round((sum / count) * 10) / 10 : null, reviews: count };
}

/**
 * Catalog order: more reviews pull the average toward a neutral 4, so one five does not outrank twenty fours and
 * a newcomer is not buried below everyone with a single mediocre review.
 */
export function catalogScore(rating: number | null, reviews: number, completed: number): number {
  const prior = 4;
  const weight = 3;
  const bayes = ((rating ?? prior) * reviews + prior * weight) / (reviews + weight);
  return bayes * 1000 + Math.min(completed, 999);
}

/** A complaint says what is wrong, so staff can check it against the stage history. */
export function checkReport(reason: unknown): { ok: true; reason: string } | { ok: false; code: string } {
  const value = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (value.length < 10 || value.length > 1000) return { ok: false, code: 'REVIEW_REPORT_INVALID' };
  return { ok: true, reason: value };
}

export function checkModeration(decision: unknown, note: unknown): { ok: true; decision: 'hide' | 'keep'; note: string } | { ok: false; code: string } {
  if (decision !== 'hide' && decision !== 'keep') return { ok: false, code: 'MODERATION_DECISION_INVALID' };
  const value = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '';
  // Both sides are told why, so a decision without a reason is not accepted.
  if (value.length < 5 || value.length > 500) return { ok: false, code: 'MODERATION_NOTE_REQUIRED' };
  return { ok: true, decision, note: value };
}
