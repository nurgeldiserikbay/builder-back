// Transactional email through Resend or Brevo (account verification uses the same path).
// Brevo is used when BREVO_API_KEY is set: it can send from a single verified address (for example a Gmail
// address) without an own domain, which suits test environments. Otherwise Resend (RESEND_API_KEY).

export type EmailProvider = 'resend' | 'brevo';
export type EmailConfig = { provider: EmailProvider; apiKey: string; from: string };

export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  if (!env.EMAIL_FROM) return null;
  if (env.BREVO_API_KEY) return { provider: 'brevo', apiKey: env.BREVO_API_KEY, from: env.EMAIL_FROM };
  if (env.RESEND_API_KEY) return { provider: 'resend', apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM };
  return null;
}

/** Splits "Name <address>" into its parts; a bare address has no name. */
export function parseFrom(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1].replace(/^"(.*)"$/, '$1').trim();
  return name ? { name, email: match[2] } : { email: match[2] };
}

function request(config: EmailConfig, to: string, subject: string, html: string): { url: string; headers: Record<string, string>; body: string } {
  const env = process.env;
  if (config.provider === 'brevo') {
    return {
      url: `${(env.BREVO_API_URL ?? 'https://api.brevo.com').replace(/\/$/, '')}/v3/smtp/email`,
      headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: parseFrom(config.from), to: [{ email: to }], subject, htmlContent: html }),
    };
  }
  return {
    url: `${(env.RESEND_API_URL ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.from, to: [to], subject, html }),
  };
}

export async function sendEmail(config: EmailConfig, to: string, subject: string, html: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const { url, headers, body } = request(config, to, subject.slice(0, 200), html);
    const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}
