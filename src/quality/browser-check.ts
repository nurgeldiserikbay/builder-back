// Checks a build in a real browser with Lighthouse. The pages are served from memory by a throw-away server on
// 127.0.0.1 with the same headers the sites server sends; Chromium gets a dead proxy and a resolver that maps every
// other host to "not found", so nothing leaves the machine. Builds contain no scripts (the release gate refuses them),
// so the browser only renders HTML, CSS and the project's own photos.
// Lab measurement on a simulated mid-range phone — not what real visitors get.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pageCsp } from '../journey/site-renderer.js';

export const BROWSER_CHECK_VERSION = '1.0.0';
export const BROWSER_CHECK_LIMITS = { pages: 7, pageTimeoutMs: 60_000 };

export type BrowserCategory = 'performance' | 'accessibility' | 'best-practices' | 'seo';
export type BrowserIssue = { id: string; category: BrowserCategory; title: string; score: number };
export type BrowserPage = {
  path: string;
  scores: Record<BrowserCategory, number | null>;
  metrics: { fcpMs: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; speedIndexMs: number | null };
  issues: BrowserIssue[];
  error: string | null;
};
export type BrowserCheckResult = {
  version: string;
  tool: { lighthouse: string; browser: string };
  formFactor: 'mobile';
  throttling: 'simulate';
  measuredAt: string;
  pages: BrowserPage[];
  skippedPages: number;
};

export class BrowserCheckError extends Error {
  constructor(readonly code: string) { super(code); }
}

const categories: BrowserCategory[] = ['performance', 'accessibility', 'best-practices', 'seo'];
// Not meaningful for a local copy: it is served over plain HTTP from 127.0.0.1; HTTPS, HTTP/2 and redirects are the
// sites server's job and are checked on the published site.
const skipAudits = ['is-on-https', 'redirects-http', 'uses-http2', 'csp-xss', 'valid-source-maps', 'bf-cache'];

type Lhr = {
  lighthouseVersion: string;
  environment?: { hostUserAgent?: string };
  runtimeError?: { code?: string };
  categories: Record<string, { score: number | null; auditRefs: Array<{ id: string; weight: number }> }>;
  audits: Record<string, { title: string; score: number | null; scoreDisplayMode: string; numericValue?: number }>;
};

/** Pure: the parts of a Lighthouse report we keep. Exported for tests. */
export function summarizeLhr(path: string, lhr: Lhr): BrowserPage {
  const score = (key: BrowserCategory) => {
    const value = lhr.categories[key]?.score;
    return typeof value === 'number' ? Math.round(value * 100) : null;
  };
  const metric = (id: string, round = true) => {
    const value = lhr.audits[id]?.numericValue;
    return typeof value === 'number' && Number.isFinite(value) ? (round ? Math.round(value) : Math.round(value * 1000) / 1000) : null;
  };
  const issues: BrowserIssue[] = [];
  for (const category of categories) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      const audit = lhr.audits[ref.id];
      if (!audit || ref.weight <= 0 || audit.scoreDisplayMode !== 'binary' && audit.scoreDisplayMode !== 'numeric' && audit.scoreDisplayMode !== 'metricSavings') continue;
      if (typeof audit.score === 'number' && audit.score < 0.9) issues.push({ id: ref.id, category, title: audit.title.slice(0, 200), score: Math.round(audit.score * 100) });
    }
  }
  issues.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return {
    path,
    scores: { performance: score('performance'), accessibility: score('accessibility'), 'best-practices': score('best-practices'), seo: score('seo') },
    metrics: { fcpMs: metric('first-contentful-paint'), lcpMs: metric('largest-contentful-paint'), cls: metric('cumulative-layout-shift', false), tbtMs: metric('total-blocking-time'), speedIndexMs: metric('speed-index') },
    issues: issues.slice(0, 15),
    error: lhr.runtimeError?.code ? String(lhr.runtimeError.code).slice(0, 60) : null,
  };
}

/** A local copy of the build: pages by path, photos the pages show, everything else 404. */
/** Photos the pages show (`/img/<id>.webp`). */
export function imageIds(pages: Array<{ html: string }>): string[] {
  const ids = new Set<string>();
  for (const page of pages) for (const match of page.html.matchAll(/\/img\/([0-9a-f-]{36})\.webp/gi)) ids.add(match[1].toLowerCase());
  return [...ids];
}

export function serveBuild(pages: Array<{ path: string; html: string }>, images: Map<string, Buffer>): Promise<{ server: Server; origin: string }> {
  const byPath = new Map(pages.map((page) => [page.path, page.html]));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    const html = byPath.get(path) ?? byPath.get(path.replace(/\/$/, '') || '/');
    if (html !== undefined) {
      const hasForm = html.includes('<form');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `${pageCsp(hasForm)}; frame-ancestors 'none'`, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }
    if (path === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`User-agent: *\nAllow: /\nSitemap: http://${request.headers.host ?? '127.0.0.1'}/sitemap.xml\n`);
      return;
    }
    const image = /^\/img\/([0-9a-f-]{36})\.webp$/i.exec(path);
    const bytes = image ? images.get(image[1].toLowerCase()) : undefined;
    if (bytes) {
      response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      response.end(bytes);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

export function browserFlags(isRoot: boolean): string[] {
  return [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--mute-audio',
    // Only the local copy is reachable: other hosts resolve to nothing and anything else goes to a closed proxy port.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1',
    ...(isRoot ? ['--no-sandbox'] : []),
  ];
}

export async function runBrowserCheck(input: { pages: Array<{ path: string; html: string }>; images: Map<string, Buffer>; locale: 'ru' | 'en' }, env: NodeJS.ProcessEnv = process.env): Promise<BrowserCheckResult> {
  const chromePath = env.CAPTURE_CHROMIUM_EXECUTABLE_PATH;
  if (!chromePath) throw new BrowserCheckError('BROWSER_NOT_CONFIGURED');
  const pages = input.pages.slice(0, BROWSER_CHECK_LIMITS.pages);
  const [{ default: lighthouse }, { launch }] = await Promise.all([import('lighthouse'), import('chrome-launcher')]);
  const { server, origin } = await serveBuild(pages, input.images);
  let chrome: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    try {
      chrome = await launch({ chromePath, chromeFlags: browserFlags(typeof process.getuid === 'function' && process.getuid() === 0), logLevel: 'silent', handleSIGINT: false, envVars: { HOME: env.HOME ?? '/tmp', TMPDIR: '/tmp', PATH: env.PATH ?? '' } });
    } catch { throw new BrowserCheckError('BROWSER_START_FAILED'); }
    const results: BrowserPage[] = [];
    let lighthouseVersion = '';
    let browser = '';
    for (const page of pages) {
      const url = `${origin}${page.path}`;
      let timer: NodeJS.Timeout | undefined;
      try {
        const run = await Promise.race([
          lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'silent', onlyCategories: categories, skipAudits, formFactor: 'mobile', throttlingMethod: 'simulate', locale: input.locale, maxWaitForLoad: 30_000 }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserCheckError('PAGE_TIMEOUT')), BROWSER_CHECK_LIMITS.pageTimeoutMs); }),
        ]);
        const lhr = run?.lhr as unknown as Lhr | undefined;
        if (!lhr) throw new BrowserCheckError('NO_REPORT');
        lighthouseVersion = lhr.lighthouseVersion;
        browser = (lhr.environment?.hostUserAgent ?? '').match(/(?:HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? browser;
        results.push(summarizeLhr(page.path, lhr));
      } catch (error) {
        const code = error instanceof BrowserCheckError ? error.code : 'PAGE_CHECK_FAILED';
        results.push({ path: page.path, scores: { performance: null, accessibility: null, 'best-practices': null, seo: null }, metrics: { fcpMs: null, lcpMs: null, cls: null, tbtMs: null, speedIndexMs: null }, issues: [], error: code });
      } finally { clearTimeout(timer); }
    }
    if (results.every((page) => page.error)) throw new BrowserCheckError(results[0]?.error ?? 'PAGE_CHECK_FAILED');
    return { version: BROWSER_CHECK_VERSION, tool: { lighthouse: lighthouseVersion, browser }, formFactor: 'mobile', throttling: 'simulate', measuredAt: new Date().toISOString(), pages: results, skippedPages: input.pages.length - pages.length };
  } finally {
    try { chrome?.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => server.close(resolve));
  }
}
