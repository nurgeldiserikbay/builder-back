// Confidentiality terms of a specialist's assignment (STAGE_WORK_MODEL §7.2).
//
// The owner turns them on with the platform's template or their own text. The specialist reads and accepts them before
// entering the stage; the accepted text is identified by its SHA-256, so the owner and the specialist can always tell
// which wording was accepted. When the owner changes the text, the stage closes for the specialist until they accept
// the new one. The platform records the acceptance; it is not a lawyer and does not judge whether the terms hold.

import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { tr } from '../i18n/i18n.js';

export const CONFIDENTIALITY_LIMITS = { min: 20, max: 4000 } as const;

/** The platform's template, in the owner's language. */
export function defaultConfidentiality(): string {
  return tr('Я не передаю третьим лицам и не публикую материалы проекта, к которым получил доступ: тексты, схемы, файлы, данные клиентов и цены. Использую их только для работы над этим этапом. После окончания работы удаляю копии, которые скачал, если владелец не разрешил оставить их. Эти условия действуют и после окончания работы над проектом.');
}

export const confidentialityHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Owner's input: null (no terms), true (the template) or the text itself. */
export function readConfidentiality(raw: unknown): string | null {
  if (raw === null || raw === false || raw === undefined) return null;
  if (raw === true) return defaultConfidentiality();
  if (typeof raw !== 'string') throw new BadRequestException('CONFIDENTIALITY_INVALID');
  const text = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < CONFIDENTIALITY_LIMITS.min || text.length > CONFIDENTIALITY_LIMITS.max) throw new BadRequestException('CONFIDENTIALITY_INVALID');
  return text;
}

/** Whether the specialist still has to accept the current text. */
export function confidentialityPending(row: { confidentialityText: string | null; confidentialityAcceptedHash: string | null }): boolean {
  return row.confidentialityText !== null && row.confidentialityAcceptedHash !== confidentialityHash(row.confidentialityText);
}

/** What the owner and the specialist see about the terms of one assignment. */
export function confidentialityView(row: { confidentialityText: string | null; confidentialityAcceptedHash: string | null; confidentialityAcceptedAt: Date | null }) {
  if (row.confidentialityText === null) return null;
  const hash = confidentialityHash(row.confidentialityText);
  const accepted = row.confidentialityAcceptedHash === hash;
  return {
    text: row.confidentialityText, hash, accepted,
    acceptedAt: accepted ? row.confidentialityAcceptedAt : null,
    // Accepted before, but the owner has changed the text since.
    changed: !accepted && row.confidentialityAcceptedHash !== null,
  };
}

export const confidentialitySelect = { confidentialityText: true, confidentialityAcceptedHash: true, confidentialityAcceptedAt: true } as const;
