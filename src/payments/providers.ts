// Payment providers behind one small interface. Freedom Pay (Kazakhstan) follows its Merchant API documentation
// (init_payment.php, result_url, MD5 signature over «script;sorted values;secret»); it is not yet verified against a live
// merchant account. The mock provider exists only for local development and tests.
import { createHash, randomBytes } from 'node:crypto';

export type ProviderKey = 'freedompay' | 'mock';
export interface CheckoutInput { orderId: string; amountTiyn: number; description: string; resultUrl: string; successUrl: string; failureUrl: string; email: string | null }
export interface CheckoutResult { redirectUrl: string; providerPaymentId: string | null }
export interface CallbackResult { orderId: string; providerPaymentId: string | null; status: 'paid' | 'failed' | 'pending'; amountTiyn: number | null; currency: string | null }
export class PaymentProviderError extends Error { constructor(readonly code: string) { super(code); } }

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');
const salt = () => randomBytes(12).toString('hex');

/** Freedom Pay signature: script name, values sorted by key, secret key — joined with «;», MD5 in lowercase hex. */
export function freedomSignature(script: string, fields: Record<string, string>, secret: string): string {
  const values = Object.keys(fields).filter((key) => key !== 'pg_sig').sort().map((key) => fields[key]!);
  return md5([script, ...values, secret].join(';'));
}
const scriptOf = (url: string) => new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
const tenge = (tiyn: number) => (tiyn / 100).toFixed(2);

function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? match[1]!.replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
}
/** All pg_* fields of a flat XML answer (every field takes part in the signature). */
function xmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of xml.matchAll(/<(pg_[a-z0-9_]+)>([\s\S]*?)<\/\1>/g)) fields[match[1]!] = match[2]!.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  return fields;
}
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface FreedomConfig { merchantId: string; secret: string; apiUrl: string; testing: boolean }

export function freedomConfig(env = process.env): FreedomConfig | null {
  const merchantId = env.FREEDOMPAY_MERCHANT_ID?.trim();
  const secret = env.FREEDOMPAY_SECRET_KEY?.trim();
  if (!merchantId || !secret) return null;
  return { merchantId, secret, apiUrl: (env.FREEDOMPAY_API_URL ?? 'https://api.freedompay.kz').replace(/\/$/, ''), testing: env.FREEDOMPAY_TESTING_MODE !== 'false' };
}

export async function freedomCheckout(config: FreedomConfig, input: CheckoutInput, fetchImpl: typeof fetch = fetch): Promise<CheckoutResult> {
  const url = `${config.apiUrl}/init_payment.php`;
  const fields: Record<string, string> = {
    pg_merchant_id: config.merchantId, pg_order_id: input.orderId, pg_amount: tenge(input.amountTiyn), pg_currency: 'KZT',
    pg_description: input.description.slice(0, 1000), pg_result_url: input.resultUrl, pg_success_url: input.successUrl, pg_failure_url: input.failureUrl,
    pg_request_method: 'POST', pg_lifetime: '3600', pg_language: 'ru', pg_salt: salt(), ...(input.email ? { pg_user_contact_email: input.email } : {}),
    ...(config.testing ? { pg_testing_mode: '1' } : {}),
  };
  fields.pg_sig = freedomSignature(scriptOf(url), fields, config.secret);
  let text: string;
  try {
    const response = await fetchImpl(url, { method: 'POST', body: new URLSearchParams(fields), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    text = await response.text();
  } catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  const status = xmlValue(text, 'pg_status');
  const redirectUrl = xmlValue(text, 'pg_redirect_url');
  if (status !== 'ok' || !redirectUrl) throw new PaymentProviderError('PAYMENT_PROVIDER_FAILED');
  // The answer is signed with the same rule; refuse an answer we cannot verify.
  if (xmlValue(text, 'pg_sig') !== freedomSignature('init_payment.php', xmlFields(text), config.secret)) throw new PaymentProviderError('PAYMENT_PROVIDER_SIGNATURE');
  if (!/^https:\/\//.test(redirectUrl)) throw new PaymentProviderError('PAYMENT_PROVIDER_FAILED');
  return { redirectUrl, providerPaymentId: xmlValue(text, 'pg_payment_id') };
}

/** Verifies and reads the result_url callback (form fields). Throws when the signature does not match. */
export function freedomCallback(config: FreedomConfig, resultUrl: string, fields: Record<string, string>): CallbackResult {
  if (!fields.pg_sig || fields.pg_sig !== freedomSignature(scriptOf(resultUrl), fields, config.secret)) throw new PaymentProviderError('PAYMENT_SIGNATURE_INVALID');
  if (fields.pg_merchant_id && fields.pg_merchant_id !== config.merchantId) throw new PaymentProviderError('PAYMENT_SIGNATURE_INVALID');
  const amount = Number(fields.pg_amount);
  return {
    orderId: fields.pg_order_id ?? '', providerPaymentId: fields.pg_payment_id ?? null,
    status: fields.pg_result === '1' ? 'paid' : fields.pg_result === '0' ? 'failed' : 'pending',
    amountTiyn: Number.isFinite(amount) ? Math.round(amount * 100) : null, currency: fields.pg_currency ?? null,
  };
}

/** Signed XML reply to result_url. */
export function freedomReply(config: FreedomConfig, resultUrl: string, status: 'ok' | 'rejected' | 'error', description: string): string {
  const fields = { pg_status: status, pg_description: description, pg_salt: salt() };
  const sig = freedomSignature(scriptOf(resultUrl), fields, config.secret);
  return `<?xml version="1.0" encoding="utf-8"?>\n<response><pg_status>${status}</pg_status><pg_description>${escapeXml(description)}</pg_description><pg_salt>${fields.pg_salt}</pg_salt><pg_sig>${sig}</pg_sig></response>`;
}

/** Which provider takes payments here: Freedom Pay when configured; the mock only outside production when asked for. */
export function activeProvider(env = process.env): ProviderKey | null {
  if (env.PAYMENTS_PROVIDER === 'mock') return env.NODE_ENV === 'production' ? null : 'mock';
  if (env.PAYMENTS_PROVIDER === 'freedompay' || (!env.PAYMENTS_PROVIDER && freedomConfig(env))) return freedomConfig(env) ? 'freedompay' : null;
  return null;
}

/**
 * Returns money through the provider. The test provider does it at once; for a real provider the refund is made in
 * its merchant cabinet by staff, who record the reference — BuildPath does not call a refund API it has not verified.
 */
export function automaticRefund(provider: string): ((paymentId: string | null, amountTiyn: number) => { reference: string }) | null {
  if (provider !== 'mock') return null;
  return (paymentId, amountTiyn) => ({ reference: `mock-refund-${(paymentId ?? 'x').slice(-8)}-${amountTiyn}` });
}
