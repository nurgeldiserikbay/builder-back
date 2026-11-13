import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal Telegram Bot API client. Messages are sent as plain text (no parse_mode), so user text cannot inject markup.

export interface TelegramConfig { token: string; botUsername: string; webhookSecret: string | null; apiBase: string }

export function telegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  const botUsername = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');
  if (!token || !botUsername) return null;
  const apiBase = (env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').replace(/\/$/, '');
  // HTTPS only; plain HTTP is accepted for a local mock in development.
  if (!apiBase.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(apiBase)) return null;
  return { token, botUsername, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null, apiBase };
}

export type InlineButton = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export type InlineKeyboard = InlineButton[][];

async function call(config: TelegramConfig, method: string, payload: Record<string, unknown>, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${config.apiBase}/bot${config.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTelegramMessage(config: TelegramConfig, chatId: string, text: string, fetchImpl: typeof fetch = fetch, keyboard?: InlineKeyboard): Promise<boolean> {
  return call(config, 'sendMessage', {
    chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true,
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }, fetchImpl);
}

export async function answerCallbackQuery(config: TelegramConfig, callbackQueryId: string, text?: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return call(config, 'answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 190) } : {}) }, fetchImpl);
}

/**
 * Verifies Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Returns the Telegram user id when the signature is valid and the data is fresh.
 */
export function verifyWebAppInitData(initData: string, botToken: string, maxAgeSeconds = 86_400, now = Date.now()): { telegramUserId: string } | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const actual = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSeconds || authDate - now / 1000 > 300) return null;
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null;
    return typeof user?.id === 'number' || typeof user?.id === 'string' ? { telegramUserId: String(user.id) } : null;
  } catch {
    return null;
  }
}

/** Downloads a file a user sent (voice message) through getFile; null when it is missing or larger than maxBytes. */
export async function downloadTelegramFile(config: TelegramConfig, fileId: string, maxBytes: number, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  try {
    const info = await fetchImpl(`${config.apiBase}/bot${config.token}/getFile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }), signal: AbortSignal.timeout(8000) });
    if (!info.ok) return null;
    const body = await info.json() as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
    const path = body.result?.file_path;
    if (!body.ok || typeof path !== 'string' || !/^[\w./-]{1,200}$/.test(path) || path.includes('..')) return null;
    if ((body.result?.file_size ?? 0) > maxBytes) return null;
    const file = await fetchImpl(`${config.apiBase}/file/bot${config.token}/${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!file.ok) return null;
    const data = Buffer.from(await file.arrayBuffer());
    return data.length <= maxBytes ? data : null;
  } catch {
    return null;
  }
}
