// Opens a published site the way a visitor would and reports whether it answered.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from '../reviews/url-target-policy.js';
import { probeOk, type Probe } from './monitor-rules.js';

const TIMEOUT_MS = 10_000;

function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;
  return ((_hostname: string, options: number | { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (typeof options === 'object' && options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

/** A short, non-sensitive cause for the owner and staff: TIMEOUT, DNS, TLS, REFUSED, HTTP_502, NOT_PUBLIC. */
export function causeOf(error: unknown): string {
  if (error instanceof ReviewTargetPolicyError) return error.code === 'URL_DNS_LOOKUP_FAILED' ? 'DNS' : 'NOT_PUBLIC';
  const code = (error as { code?: string })?.code ?? '';
  const message = error instanceof Error ? error.message : '';
  if (message === 'PROBE_TIMEOUT' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'REFUSED';
  if (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'EPROTO') return 'TLS';
  return 'ERROR';
}

/**
 * `trusted` is for BuildPath's own subdomains, whose address comes from the platform config. An owner's domain is
 * resolved first, must point at a public address, and the connection is pinned to that address — so a domain whose
 * DNS was changed later cannot make the platform call into a private network. Redirects are not followed.
 */
export async function probeSite(url: string, trusted: boolean): Promise<Probe> {
  const started = Date.now();
  try {
    let lookup: LookupFunction | undefined;
    if (!trusted) {
      const target = await resolveAndValidateReviewTarget(url);
      lookup = pinnedLookup(target.resolvedAddresses[0]!);
    }
    const parsed = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(parsed, { method: 'GET', headers: { 'user-agent': 'BuildPathUptime/1.0 (+availability check)', accept: 'text/html', 'accept-encoding': 'identity' }, ...(lookup ? { lookup } : {}) }, (response) => {
        // Only the status matters; the body is dropped without being read into memory.
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('PROBE_TIMEOUT')));
      request.once('error', reject);
      request.end();
    });
    const ok = probeOk(status);
    return { ok, status, ms: Date.now() - started, error: ok ? null : `HTTP_${status}` };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: causeOf(error) };
  }
}
