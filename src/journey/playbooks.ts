// Personal playbooks of specialists (STAGE_WORK_MODEL §7.4).
//
// A playbook is the specialist's own reusable know-how for one kind of stage: instructions for the AI and a checklist for the
// result. It belongs to the specialist, not to any project, so it must not carry project data. Before it can be attached it
// passes deterministic checks:
// - no contact data or links (e-mails, phone numbers, URLs) — those are always someone's project data;
// - no text from the project it is being attached to (business name, contacts);
// - no attempts to steer the AI past the platform rules (prompt injection patterns, code, markup).
// The owner sees the attached playbook, its version and check result; the AI gets it as advice below the project's rules.

import { BadRequestException } from '@nestjs/common';
import { stageDefinitions, type StageKey, definitionOf } from './catalog.js';
import type { Brief } from './artifacts.js';

export const PLAYBOOK_LIMITS = { title: 80, items: 20, itemLength: 300, perUser: 30 } as const;

export interface PlaybookContent { title: string; stageKey: StageKey; instructions: string[]; checklist: string[] }
export interface PlaybookIssue { code: string; item: string; text: string }

const EMAIL = /[^\s@]+@[^\s@]+\.[a-zа-я]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]*){9,}/;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:kz|ru|com|net|org|io|me|app|site|shop|store)\b/i;
const MARKUP = /<\s*\/?\s*[a-z][^>]*>|```|\{\{|\}\}|javascript:/i;
/** Phrases that try to override the platform rules, reveal hidden text or change the AI's role. Russian, Kazakh and English. */
const INJECTION = [
  /ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier)/i, /disregard\s+(?:the\s+|all\s+)?(?:rules|instructions)/i,
  /system\s*prompt/i, /you\s+are\s+now/i, /act\s+as\s+(?:an?\s+)?(?:admin|developer|system)/i, /reveal|jailbreak|developer\s+mode/i,
  /игнорир\p{L}*\s+(?:все\s+|предыдущ|прошл|правил|инструкц)/iu, /забудь\s+(?:все\s+)?(?:правила|инструкции|предыдущ)/iu,
  /системн\p{L}+\s+(?:промпт|подсказк|инструкц)/iu, /ты\s+теперь/iu, /раскрой|покажи\s+скрыт/iu, /обойди\s+(?:правил|огранич|провер)/iu,
  /нұсқаулар\p{L}*\s+елеме/iu,
];

export function playbookTitle(stageKey: string): string {
  return definitionOf(stageKey as StageKey)?.title ?? stageKey;
}

/** Shape and limits; throws on a malformed request. */
export function parsePlaybook(raw: unknown): PlaybookContent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('PLAYBOOK_INVALID');
  const input = raw as Record<string, unknown>;
  const title = typeof input.title === 'string' ? input.title.trim().replace(/\s+/g, ' ') : '';
  if (title.length < 3 || title.length > PLAYBOOK_LIMITS.title) throw new BadRequestException('PLAYBOOK_TITLE_INVALID');
  const stageKey = input.stageKey;
  if (typeof stageKey !== 'string' || !(stageKey in stageDefinitions) || definitionOf(stageKey as StageKey).ai.level === 'none') throw new BadRequestException('PLAYBOOK_STAGE_INVALID');
  const list = (value: unknown, code: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PLAYBOOK_LIMITS.items || value.some((item) => typeof item !== 'string')) throw new BadRequestException(code);
    const items = (value as string[]).map((item) => item.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (items.some((item) => item.length > PLAYBOOK_LIMITS.itemLength)) throw new BadRequestException(code);
    return [...new Set(items)];
  };
  const instructions = list(input.instructions, 'PLAYBOOK_INSTRUCTIONS_INVALID');
  const checklist = list(input.checklist, 'PLAYBOOK_CHECKLIST_INVALID');
  if (!instructions.length && !checklist.length) throw new BadRequestException('PLAYBOOK_EMPTY');
  return { title, stageKey: stageKey as StageKey, instructions, checklist };
}

/** Values of a project that must not end up in anyone's personal playbook. */
export function projectFingerprints(brief: Partial<Brief> | null | undefined): string[] {
  if (!brief) return [];
  return [brief.businessName, brief.phone, brief.messenger, brief.email, brief.address]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 4);
}

/** Deterministic checks; an empty list means the playbook may be used. */
export function checkPlaybook(content: Pick<PlaybookContent, 'title' | 'instructions' | 'checklist'>, fingerprints: string[] = []): PlaybookIssue[] {
  const issues: PlaybookIssue[] = [];
  for (const item of [content.title, ...content.instructions, ...content.checklist]) {
    const lower = item.toLowerCase();
    if (EMAIL.test(item) || PHONE.test(item) || URL.test(item)) issues.push({ code: 'CONTACT_DATA', item, text: 'Похоже на контакты или ссылку — в личном плейбуке их быть не должно: это данные чьего-то проекта.' });
    if (fingerprints.some((value) => lower.includes(value))) issues.push({ code: 'PROJECT_DATA', item, text: 'Здесь есть данные проекта (название или контакты). Обобщите правило: напишите его так, чтобы оно подходило любому клиенту.' });
    if (INJECTION.some((pattern) => pattern.test(item))) issues.push({ code: 'OVERRIDE_ATTEMPT', item, text: 'Похоже на попытку изменить правила платформы для ИИ. Плейбук может только советовать, как делать работу.' });
    if (MARKUP.test(item)) issues.push({ code: 'MARKUP', item, text: 'Код, разметка и шаблоны в плейбуке не допускаются — только обычный текст.' });
  }
  return issues;
}
