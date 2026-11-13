/**
 * Spam protection for forms on published sites without scripts or third-party captchas: the sites server writes a signed
 * time token into every form it serves and, when the owner turns it on, a short arithmetic question. A form sent faster
 * than a person can fill it, or with a wrong answer, is not accepted. Honeypot and rate limits stay as they were.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { tr } from '../i18n/i18n.js';

export const TOKEN_FIELD = '_g';
export const ANSWER_FIELD = '_q';
/** Written by the renderer into each form; replaced on every response. */
export const TOKEN_PLACEHOLDER = '__BP_FORM_TOKEN__';
export const QUESTION_PLACEHOLDER = '<!--bp-form-question-->';
export const MIN_FILL_MS = 3_000;
export const MAX_AGE_MS = 24 * 3_600_000;

/** required — the page the form came from was served with a token (every page built since the guard was added). */
export type GuardOptions = { secret: string; siteId: string; question: boolean; required?: boolean; now?: number };

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
}

/** A fresh token; with a question, its two numbers travel in the token and are covered by the signature. */
export function issueToken(options: GuardOptions, numbers?: [number, number]): string {
  const issued = Math.floor((options.now ?? Date.now()) / 1000);
  const pair = numbers ? `${numbers[0]}-${numbers[1]}` : '';
  return `${issued}.${pair}.${sign(options.secret, `${options.siteId}|${issued}|${pair}`)}`;
}

/** Fills the placeholders of a page; pages built before the guard have none and are sent as they are. */
export function guardHtml(html: string, options: GuardOptions): string {
  if (!html.includes(TOKEN_PLACEHOLDER)) return html;
  return html.replace(/__BP_FORM_TOKEN__([\s\S]*?)<!--bp-form-question-->/g, (_whole, between: string) => {
    const numbers: [number, number] | undefined = options.question ? [randomInt(1, 10), randomInt(1, 10)] : undefined;
    const token = issueToken(options, numbers);
    const question = numbers
      ? `<label class="question">${tr('Защита от спама: сколько будет {0} + {1}?', numbers)}<input name="${ANSWER_FIELD}" required inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"></label>`
      : '';
    return `${token}${between}${question}`;
  }).replaceAll(TOKEN_PLACEHOLDER, issueToken(options)).replaceAll(QUESTION_PLACEHOLDER, '');
}

export type GuardResult = { ok: true } | { ok: false; reason: 'spam' | 'expired' | 'answer'; message: string };

/**
 * spam — sent faster than a person fills a form: answered like a success, so a bot learns nothing.
 * expired — the page is old or the server key changed: the visitor reloads and sends again.
 * answer — the question was answered wrongly.
 */
export function checkGuard(form: URLSearchParams, options: GuardOptions): GuardResult {
  const raw = form.get(TOKEN_FIELD);
  // Forms on pages built before the guard carry no token; they are still protected by the honeypot and the limits.
  // Where the page had a token, a form without one did not come from it.
  if (raw === null) return options.required === false ? { ok: true } : { ok: false, reason: 'expired', message: tr('Страница устарела. Обновите её и отправьте форму снова.') };
  const [issuedText, pair, signature] = raw.split('.');
  const issued = Number(issuedText);
  const expected = Number.isInteger(issued) && pair !== undefined ? sign(options.secret, `${options.siteId}|${issued}|${pair}`) : '';
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return { ok: false, reason: 'expired', message: tr('Страница устарела. Обновите её и отправьте форму снова.') };
  }
  const age = (options.now ?? Date.now()) - issued * 1000;
  if (age > MAX_AGE_MS) return { ok: false, reason: 'expired', message: tr('Страница устарела. Обновите её и отправьте форму снова.') };
  if (age < MIN_FILL_MS) return { ok: false, reason: 'spam', message: '' };
  if (pair) {
    const [a, b] = pair.split('-').map(Number);
    const answer = (form.get(ANSWER_FIELD) ?? '').trim();
    if (!/^\d{1,3}$/.test(answer) || Number(answer) !== (a ?? NaN) + (b ?? NaN)) return { ok: false, reason: 'answer', message: tr('Ответ на вопрос от спама неверный. Вернитесь назад, обновите страницу и попробуйте ещё раз.') };
  } else if (options.question) {
    // The owner turned the question on after this page was opened.
    return { ok: false, reason: 'expired', message: tr('Страница устарела. Обновите её и отправьте форму снова.') };
  }
  return { ok: true };
}

/** What the renderer puts into a form: the token field, then the place for the question. */
export const guardFields = (): string => `<input type="hidden" name="${TOKEN_FIELD}" value="${TOKEN_PLACEHOLDER}">${QUESTION_PLACEHOLDER}`;
