// Step 4: asks the owner's running application for /api/health, with the same safety as other checks of owner addresses:
// the name must resolve to a public address, the connection is pinned to it, redirects are not followed, the answer is cut.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { causeOf, pinnedLookup } from '../monitoring/site-probe.js';
import { resolveAndValidateReviewTarget } from '../reviews/url-target-policy.js';

export interface HealthAnswer { ok: boolean; status: number | null; database: string | null; error: string | null; ms: number }

/** The address the owner pasted, reduced to its origin; null when it is not an https address (http only for local tests). */
export function appOrigin(raw: string, allowLocal: boolean): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) return null;
  return url.origin;
}

export async function checkAppHealth(origin: string, trusted: boolean): Promise<HealthAnswer> {
  const started = Date.now();
  try {
    let lookup: LookupFunction | undefined;
    if (!trusted) lookup = pinnedLookup((await resolveAndValidateReviewTarget(`${origin}/`)).resolvedAddresses[0]!);
    const target = new URL('/api/health', origin);
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(target, { method: 'GET', headers: { 'user-agent': 'BuildPathCheck/1.0 (+app health)', accept: 'application/json', 'accept-encoding': 'identity' }, ...(lookup ? { lookup } : {}) }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; if (body.length > 10_000) response.destroy(); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        response.on('close', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      // A free Render service sleeps and wakes up in about a minute.
      request.setTimeout(60_000, () => request.destroy(new Error('PROBE_TIMEOUT')));
      request.once('error', reject);
      request.end();
    });
    let parsed: { status?: unknown; database?: unknown } = {};
    try { parsed = JSON.parse(body) as typeof parsed; } catch { parsed = {}; }
    const ok = status === 200 && parsed.status === 'ok';
    const database = typeof parsed.database === 'string' && /^[a-z]{1,20}$/.test(parsed.database) ? parsed.database : null;
    return { ok, status, database, error: ok ? null : status === 200 ? 'NOT_HEALTH_ANSWER' : `HTTP_${status}`, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: null, database: null, error: causeOf(error), ms: Date.now() - started };
  }
}
