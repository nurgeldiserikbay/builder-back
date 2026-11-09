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

export async function sendTelegramMessage(config: TelegramConfig, chatId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${config.apiBase}/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
