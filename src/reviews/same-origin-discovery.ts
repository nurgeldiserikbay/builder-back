import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction, LookupFunctionOptions } from 'node:net';
import { URL } from 'node:url';
import { resolveAndValidateReviewTarget } from './url-target-policy';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'BuildPathReviewBot/0.1';

export interface ReviewDiscoveryOptions {
  readonly maxPages?: number;
  readonly maxDepth?: number;
}

export interface DiscoveredReviewPage {
  readonly url: string;
  readonly depth: number;
  readonly title: string | null;
}

interface QueuedPage {
  readonly url: string;
  readonly depth: number;
}

interface HtmlResponse {
  readonly url: string;
  readonly html: string;
}

/**
 * Bounded same-origin discovery for a future isolated review worker.
 *
 * It performs read-only GET requests, pins each connection to an address
 * already checked by the URL policy, revalidates redirects, and never returns
 * content from non-HTML responses. This module is not exposed as an API route;
 * run it only in a worker with restricted network egress.
 */
export async function discoverSameOriginPages(
  rawUrl: string,
  options: ReviewDiscoveryOptions = {},
): Promise<readonly DiscoveredReviewPage[]> {
  const maxPages = options.maxPages ?? 30;
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('INVALID_MAX_PAGES');
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) {
    throw new Error('INVALID_MAX_DEPTH');
  }

  const initialTarget = await resolveAndValidateReviewTarget(rawUrl);
  const initialUrl = new URL(initialTarget.url);
  const allowedOrigin = initialUrl.origin;
  const rootUrl = normalizePageUrl(initialUrl);
  const sitemapUrls = await readSitemapUrls(allowedOrigin).catch(() => []);

  const queue: QueuedPage[] = [{ url: rootUrl, depth: 0 }];
  for (const sitemapUrl of sitemapUrls) {
    if (queue.length >= maxPages) break;
    if (sitemapUrl !== rootUrl) queue.push({ url: sitemapUrl, depth: 0 });
  }

  const queued = new Set(queue.map(({ url }) => url));
  const visited = new Set<string>();
  const pages: DiscoveredReviewPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);

    let response: HtmlResponse;
    try {
      response = await fetchHtml(current.url, allowedOrigin);
    } catch {
      // Keep a failed route out of the discovered-page list. A later job
      // status can report individual failures without discarding good pages.
      continue;
    }

    pages.push({
      url: response.url,
      depth: current.depth,
      title: extractTitle(response.html),
    });

    if (current.depth >= maxDepth) continue;
    for (const link of extractSameOriginLinks(response.html, response.url, allowedOrigin)) {
      if (visited.has(link) || queued.has(link) || queue.length + pages.length >= maxPages) continue;
      queued.add(link);
      queue.push({ url: link, depth: current.depth + 1 });
    }
  }

  return pages;
}

async function readSitemapUrls(origin: string): Promise<readonly string[]> {
  const sitemapUrl = new URL('/sitemap.xml', origin).toString();
  const response = await fetchHtml(sitemapUrl, origin);
  const urls: string[] = [];
  const locPattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc\s*>/gi;
  for (const match of response.html.matchAll(locPattern)) {
    const value = decodeEntities((match[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    if (!value) continue;
    try {
      const parsed = new URL(value, response.url);
      if (parsed.origin !== origin) continue;
      const normalized = normalizePageUrl(parsed);
      if (!urls.includes(normalized)) urls.push(normalized);
      if (urls.length >= 100) break;
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return urls;
}

async function fetchHtml(rawUrl: string, allowedOrigin: string, redirects = 0): Promise<HtmlResponse> {
  const target = await resolveAndValidateReviewTarget(rawUrl);
  const targetUrl = new URL(target.url);
  if (targetUrl.origin !== allowedOrigin) throw new Error('CROSS_ORIGIN_TARGET');

  return new Promise<HtmlResponse>((resolve, reject) => {
    const requestFunction = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const lookup = createPinnedLookup(target.resolvedAddresses);
    const request = requestFunction(targetUrl, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-encoding': 'identity',
        'user-agent': USER_AGENT,
      },
      lookup,
    }, (response) => {
      void handleResponse(response, targetUrl, allowedOrigin, redirects, resolve, reject);
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('REQUEST_TIMEOUT')));
    request.once('error', reject);
    request.end();
  });
}

async function handleResponse(
  response: IncomingMessage,
  requestedUrl: URL,
  allowedOrigin: string,
  redirects: number,
  resolve: (value: HtmlResponse) => void,
  reject: (reason: Error) => void,
): Promise<void> {
  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(status)) {
    response.resume();
    if (redirects >= MAX_REDIRECTS || typeof location !== 'string') {
      reject(new Error('REDIRECT_LIMIT_OR_INVALID_LOCATION'));
      return;
    }
    let nextUrl: string;
    try {
      nextUrl = new URL(location, requestedUrl).toString();
    } catch {
      reject(new Error('INVALID_REDIRECT_URL'));
      return;
    }
    response.once('end', () => {
      void fetchHtml(nextUrl, allowedOrigin, redirects + 1).then(resolve, reject);
    });
    return;
  }

  if (status < 200 || status >= 300) {
    response.resume();
    reject(new Error('UPSTREAM_STATUS'));
    return;
  }

  const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    response.resume();
    reject(new Error('UNSUPPORTED_CONTENT_TYPE'));
    return;
  }

  const declaredSize = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    response.destroy(new Error('RESPONSE_TOO_LARGE'));
    reject(new Error('RESPONSE_TOO_LARGE'));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy(new Error('RESPONSE_TOO_LARGE'));
      reject(new Error('RESPONSE_TOO_LARGE'));
      return;
    }
    chunks.push(buffer);
  });
  response.once('end', () => {
    resolve({ url: normalizePageUrl(requestedUrl), html: Buffer.concat(chunks).toString('utf8') });
  });
  response.once('error', reject);
}

function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const address = addresses[0];
  if (!address) throw new Error('NO_PUBLIC_ADDRESS');
  const family = address.includes(':') ? 6 : 4;
  return (_hostname: string, options: LookupFunctionOptions, callback: Parameters<LookupFunction>[2]) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

function extractSameOriginLinks(html: string, pageUrl: string, allowedOrigin: string): readonly string[] {
  const links: string[] = [];
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const href = decodeEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
    if (!href || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    try {
      const parsed = new URL(href, pageUrl);
      if (parsed.origin !== allowedOrigin) continue;
      const normalized = normalizePageUrl(parsed);
      if (!links.includes(normalized)) links.push(normalized);
      if (links.length >= 500) break;
    } catch {
      // Ignore malformed or unsupported links.
    }
  }
  return links;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
  return title ? title.slice(0, 200) : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&#39;': "'",
    };
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    const hex = lower.match(/^&#x([0-9a-f]+);$/);
    const decimal = lower.match(/^&#(\d+);$/);
    const codePoint = hex ? Number.parseInt(hex[1] ?? '', 16) : decimal ? Number.parseInt(decimal[1] ?? '', 10) : NaN;
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function normalizePageUrl(value: URL): string {
  const normalized = new URL(value.toString());
  normalized.hash = '';
  return normalized.toString();
}
