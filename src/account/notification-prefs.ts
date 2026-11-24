// What a person wants to be told about, and where. «Входящие» always show everything that waits for them;
// these settings decide only Telegram and e-mail. Security notices (a new sign-in, two-step changes) always go out.
import { BadRequestException } from '@nestjs/common';

export const NOTIFY_CATEGORIES = ['stages', 'team', 'money', 'site'] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number] | 'security';
export type Channels = { telegram: boolean; email: boolean };
export type NotificationPrefs = Record<(typeof NOTIFY_CATEGORIES)[number], Channels>;

/**
 * Telegram on everywhere (as before); e-mail on where a missed message costs money or a decision, off for the frequent
 * stage work, which is in «Входящие» anyway.
 */
export const DEFAULT_PREFS: NotificationPrefs = {
  stages: { telegram: true, email: false },
  team: { telegram: true, email: true },
  money: { telegram: true, email: true },
  site: { telegram: true, email: true },
};

/** Stored JSON may be partial or from an older version: missing parts take the defaults. */
export function prefsOf(stored: unknown): NotificationPrefs {
  const input = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out = structuredClone(DEFAULT_PREFS);
  for (const category of NOTIFY_CATEGORIES) {
    const value = input[category];
    if (!value || typeof value !== 'object') continue;
    const channels = value as Record<string, unknown>;
    if (typeof channels.telegram === 'boolean') out[category].telegram = channels.telegram;
    if (typeof channels.email === 'boolean') out[category].email = channels.email;
  }
  return out;
}

export function parsePrefs(raw: unknown): NotificationPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(NOTIFY_CATEGORIES as readonly string[]).includes(key)) throw new BadRequestException('UNKNOWN_FIELD');
  for (const value of Object.values(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_CHANNELS');
    for (const [channel, on] of Object.entries(value as Record<string, unknown>)) {
      if (!['telegram', 'email'].includes(channel) || typeof on !== 'boolean') throw new BadRequestException('INVALID_CHANNELS');
    }
  }
  return prefsOf(input);
}

export function channelsFor(prefs: NotificationPrefs, category: NotifyCategory): Channels {
  return category === 'security' ? { telegram: true, email: true } : prefs[category];
}
