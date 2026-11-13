// Checks a published site at the address visitors use: HTTPS, protective headers, redirect from http and robots.txt.
// These are what the release gate cannot see in the HTML (STAGE_WORK_MODEL.md §36, «Ещё нет»).
import { causeOf, fetchHeaders, type Answer } from './site-probe.js';

export type LiveItem = { id: string; status: 'passed' | 'failed' | 'unknown'; detail: string | null };
export type LiveCheck = { url: string; checkedAt: string; reachable: boolean; error: string | null; ms: number | null; items: LiveItem[] };

const HALF_YEAR = 15_552_000;

/** Pure: judges the answers. `main` is the page, `plain` the same address over http (null when the site is http only). */
export function judge(url: string, main: Answer | null, plain: Answer | { error: string } | null, robots: Answer | null): LiveItem[] {
  const https = url.startsWith('https://');
  const h = main?.headers ?? {};
  const csp = h['content-security-policy'] ?? '';
  const item = (id: string, ok: boolean | null, detail: string | null = null): LiveItem => ({ id, status: ok === null ? 'unknown' : ok ? 'passed' : 'failed', detail });
  if (!main) return ['https', 'hsts', 'http_redirect', 'csp', 'frame', 'nosniff', 'referrer', 'permissions', 'robots'].map((id) => item(id, null));
  const maxAge = Number(/max-age=(\d+)/i.exec(h['strict-transport-security'] ?? '')?.[1] ?? 0);
  let redirect: boolean | null = null;
  if (https && plain) redirect = 'status' in plain ? [301, 302, 307, 308].includes(plain.status) && (plain.headers.location ?? '').startsWith('https://') : false;
  return [
    item('https', https),
    item('hsts', https ? maxAge >= HALF_YEAR : false, maxAge ? String(maxAge) : null),
    item('http_redirect', https ? redirect : false),
    item('csp', /default-src/i.test(csp)),
    item('frame', /frame-ancestors/i.test(csp) || /^(deny|sameorigin)$/i.test(h['x-frame-options'] ?? '')),
    item('nosniff', /nosniff/i.test(h['x-content-type-options'] ?? '')),
    item('referrer', Boolean(h['referrer-policy'])),
    item('permissions', Boolean(h['permissions-policy'])),
    item('robots', robots ? robots.status === 200 : null),
  ];
}

export async function liveCheck(url: string, trusted: boolean): Promise<LiveCheck> {
  const checkedAt = new Date().toISOString();
  let main: Answer;
  try { main = await fetchHeaders(url, trusted); } catch (error) {
    return { url, checkedAt, reachable: false, error: causeOf(error), ms: null, items: judge(url, null, null, null) };
  }
  const plainUrl = url.startsWith('https://') ? `http://${url.slice('https://'.length)}` : null;
  const [plain, robots] = await Promise.all([
    plainUrl ? fetchHeaders(plainUrl, trusted).catch((error: unknown) => ({ error: causeOf(error) })) : Promise.resolve(null),
    fetchHeaders(new URL('/robots.txt', url).toString(), trusted).catch(() => null),
  ]);
  return { url, checkedAt, reachable: main.status >= 200 && main.status < 400, error: main.status >= 400 ? `HTTP_${main.status}` : null, ms: main.ms, items: judge(url, main, plain, robots) };
}
