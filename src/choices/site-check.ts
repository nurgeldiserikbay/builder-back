// Opens a deployed site and compares it with the accepted version. Every address, including redirects, must be public.
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from '../reviews/url-target-policy.js';

export type SiteCheckStatus = 'matches' | 'outdated' | 'different' | 'unreachable' | 'not_allowed';
export type SiteCheckResult = { status: SiteCheckStatus; finalUrl: string | null; httpStatus: number | null };

const MAX_BYTES = 3 * 1024 * 1024;
const normalize = (html: string) => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const titleOf = (html: string) => /<title>([^<]{1,300})<\/title>/i.exec(html)?.[1]?.trim() ?? null;

export function compareSite(expected: string, actual: string): 'matches' | 'outdated' | 'different' {
  if (normalize(expected) === normalize(actual)) return 'matches';
  const title = titleOf(expected);
  return title && titleOf(actual) === title ? 'outdated' : 'different';
}

export async function checkSite(rawUrl: string, expected: string, options: { allowLocal: boolean; fetchImpl?: typeof fetch }): Promise<SiteCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return { status: 'not_allowed', finalUrl: null, httpStatus: null }; }
  for (let hop = 0; hop < 4; hop += 1) {
    const local = options.allowLocal && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (!local) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { status: 'not_allowed', finalUrl: null, httpStatus: null };
      try { await resolveAndValidateReviewTarget(url.toString()); } catch (error) {
        if (error instanceof ReviewTargetPolicyError) return { status: 'not_allowed', finalUrl: url.toString(), httpStatus: null };
        throw error;
      }
    }
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'BuildPath site check', Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return { status: 'unreachable', finalUrl: url.toString(), httpStatus: null };
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    if (!response.ok) return { status: 'unreachable', finalUrl: url.toString(), httpStatus: response.status };
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return { status: 'different', finalUrl: url.toString(), httpStatus: response.status }; }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { status: compareSite(expected, body), finalUrl: url.toString(), httpStatus: response.status };
  }
  return { status: 'unreachable', finalUrl: url.toString(), httpStatus: null };
}
