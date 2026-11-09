// Transactional email through Resend (same provider as account verification).

export function emailConfig(env: NodeJS.ProcessEnv = process.env): { apiKey: string; from: string } | null {
  return env.RESEND_API_KEY && env.EMAIL_FROM ? { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM } : null;
}

export async function sendEmail(config: { apiKey: string; from: string }, to: string, subject: string, html: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [to], subject: subject.slice(0, 200), html }),
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
