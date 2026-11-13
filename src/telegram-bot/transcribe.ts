/**
 * Speech recognition for voice messages in the bot, through the same OpenAI-compatible provider as stage AI.
 * Off unless BUILDER_AI_TRANSCRIBE_MODEL is set. The audio is sent once and not stored; only the recognised text is kept
 * until the person confirms or cancels it.
 */
export const VOICE_LIMITS = { seconds: 120, bytes: 2_500_000, perDay: 30 };

export type TranscribeConfig = { apiKey: string; model: string; baseUrl: string };

export function transcribeConfig(env: NodeJS.ProcessEnv = process.env): TranscribeConfig | null {
  const apiKey = env.BUILDER_AI_OPENAI_API_KEY;
  const model = env.BUILDER_AI_TRANSCRIBE_MODEL;
  if (!apiKey || !model) return null;
  const baseUrl = (env.BUILDER_AI_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${baseUrl}/`)) return null;
  return { apiKey, model, baseUrl };
}

/** Text of the recording, trimmed; null when the provider fails or hears nothing. */
export async function transcribe(config: TranscribeConfig, audio: Buffer, language: 'ru' | 'en' | 'kk', fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', config.model);
  form.append('language', language);
  form.append('response_format', 'json');
  try {
    const response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return null;
    const body = await response.json() as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return text || null;
  } catch {
    return null;
  }
}
