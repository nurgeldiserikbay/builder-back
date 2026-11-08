import { chromium } from 'playwright-core';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { resolveAndValidateReviewTarget } from './url-target-policy.js';

const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_REQUESTS = 500;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export interface ReviewPageCaptureInput {
  targetUrl: string;
  viewport: { width: number; height: number; deviceScale: number };
}

export interface ReviewPageAudit {
  checkedAt: string;
  pageTitlePresent: boolean;
  languagePresent: boolean;
  h1Count: number;
  imagesMissingAlt: number;
  linksMissingName: number;
  buttonsMissingName: number;
  formControlsMissingLabel: number;
  performance: { navigationMs: number | null; ttfbMs: number | null; transferBytes: number; resourceCount: number };
  security: { isHttps: boolean; hsts: boolean | null; contentSecurityPolicy: boolean; xContentTypeOptions: boolean; referrerPolicy: boolean; permissionsPolicy: boolean; frameProtection: boolean };
}

export interface ReviewPageCaptureResult {
  bytes: Buffer;
  audit: ReviewPageAudit;
  sha256: string;
  finalUrl: string;
  toolVersion: string;
}

interface SafeResource {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Captures one unauthenticated, same-origin page using a fresh browser context.
 * Every HTTP request is fulfilled by the worker's pinned-IP fetch path; Chromium
 * itself receives no storage/database credentials and no direct third-party
 * network requests are allowed.
 */
export async function captureReviewPage(input: ReviewPageCaptureInput): Promise<ReviewPageCaptureResult> {
  const executablePath = process.env.CAPTURE_CHROMIUM_EXECUTABLE_PATH;
  if (!executablePath) throw new Error('CAPTURE_BROWSER_NOT_CONFIGURED');
  try { await access(executablePath, constants.X_OK); } catch { throw new Error('CAPTURE_BROWSER_EXECUTABLE_NOT_FOUND'); }

  const initial = await resolveAndValidateReviewTarget(input.targetUrl);
  const allowedOrigin = new URL(initial.url).origin;
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: true,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: '/tmp',
    },
  });

  try {
    const context = await browser.newContext({
      viewport: { width: input.viewport.width, height: input.viewport.height },
      deviceScaleFactor: input.viewport.deviceScale,
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
      bypassCSP: false,
    });
    let requestCount = 0;
    let totalBytes = 0;
    await context.route('**/*', async (route) => {
      try {
        requestCount += 1;
        if (requestCount > MAX_REQUESTS) return await route.abort('blockedbyclient');
        const request = route.request();
        if (request.method() !== 'GET') return await route.abort('blockedbyclient');
        let redirects = 0;
        for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) redirects += 1;
        if (redirects > MAX_REDIRECTS) return await route.abort('blockedbyclient');

        const resourceUrl = new URL(request.url());
        if (resourceUrl.protocol !== 'http:' && resourceUrl.protocol !== 'https:') return await route.continue();
        if (resourceUrl.origin !== allowedOrigin) return await route.abort('blockedbyclient');

        const resource = await fetchPinnedResource(resourceUrl.toString(), allowedOrigin);
        totalBytes += resource.body.length;
        if (totalBytes > MAX_TOTAL_BYTES) return await route.abort('blockedbyclient');
        return await route.fulfill({ status: resource.status, headers: resource.headers, body: resource.body });
      } catch {
        return await route.abort('failed');
      }
    });
    await context.routeWebSocket('**/*', () => {});
    await context.addInitScript(() => {
      Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
      Object.defineProperty(window, 'webkitRTCPeerConnection', { value: undefined });
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    const response = await page.goto(initial.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    if (!response || response.status() >= 400) throw new Error('CAPTURE_NAVIGATION_FAILED');
    await page.waitForTimeout(750);
    const finalUrl = page.url();
    if (new URL(finalUrl).origin !== allowedOrigin) throw new Error('CAPTURE_CROSS_ORIGIN_REDIRECT');
    const auditCounts = await page.evaluate(() => {
      const hasName = (element: Element): boolean => {
        const ariaLabel = element.getAttribute('aria-label')?.trim();
        const title = element.getAttribute('title')?.trim();
        const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .some(Boolean);
        const ownText = element.textContent?.trim();
        const imageAlt = Array.from(element.querySelectorAll('img[alt]')).some((image) => image.getAttribute('alt')?.trim());
        return Boolean(ariaLabel || title || labelledBy || ownText || imageAlt);
      };
      const formControls = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea'));
      const formControlsMissingLabel = formControls.filter((element) => {
        const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .some(Boolean);
        const labelText = element.getAttribute('aria-label')?.trim();
        const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).some((label) => Boolean(label.textContent?.trim())) : false;
        return !labelText && !labelledBy && !labels;
      }).length;
      return {
        pageTitlePresent: Boolean(document.title.trim()),
        languagePresent: Boolean(document.documentElement.lang.trim()),
        h1Count: document.querySelectorAll('h1').length,
        imagesMissingAlt: Array.from(document.images).filter((image) => !image.hasAttribute('alt')).length,
        linksMissingName: Array.from(document.querySelectorAll('a[href]')).filter((element) => !hasName(element)).length,
        buttonsMissingName: Array.from(document.querySelectorAll('button')).filter((element) => !hasName(element)).length,
        formControlsMissingLabel,
      };
    });
    const performanceMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const measured = (value: number) => Number.isFinite(value) && value > 0 ? Math.round(value) : null;
      const navigationMs = navigation
        ? measured((navigation.loadEventEnd > 0 ? navigation.loadEventEnd : navigation.domContentLoadedEventEnd) - navigation.startTime)
        : null;
      const ttfbMs = navigation ? measured(navigation.responseStart - navigation.requestStart) : null;
      const transferBytes = Math.min(50 * 1024 * 1024, (navigation?.transferSize ?? 0) + resources.reduce((total, resource) => total + Math.max(0, resource.transferSize || resource.encodedBodySize || 0), 0));
      return { navigationMs, ttfbMs, transferBytes, resourceCount: Math.min(500, resources.length + (navigation ? 1 : 0)) };
    });
    const responseHeaders = response.headers();
    const isHttps = new URL(finalUrl).protocol === 'https:';
    const csp = responseHeaders['content-security-policy'] ?? '';
    const frameProtection = Boolean(responseHeaders['x-frame-options']) || /(?:^|;)\s*frame-ancestors\s/i.test(csp);
    const audit: ReviewPageAudit = {
      ...auditCounts,
      checkedAt: new Date().toISOString(),
      performance: performanceMetrics,
      security: {
        isHttps,
        hsts: isHttps ? Boolean(responseHeaders['strict-transport-security']) : null,
        contentSecurityPolicy: Boolean(csp),
        xContentTypeOptions: /\bnosniff\b/i.test(responseHeaders['x-content-type-options'] ?? ''),
        referrerPolicy: Boolean(responseHeaders['referrer-policy']),
        permissionsPolicy: Boolean(responseHeaders['permissions-policy']),
        frameProtection,
      },
    };
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled', fullPage: false, timeout: NAVIGATION_TIMEOUT_MS });
    if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) throw new Error('CAPTURE_SCREENSHOT_SIZE_INVALID');
    const { createHash } = await import('node:crypto');
    await context.close();
    return { bytes, audit, sha256: createHash('sha256').update(bytes).digest('hex'), finalUrl, toolVersion: 'playwright-core/1.63' };
  } finally {
    await browser.close();
  }
}

async function fetchPinnedResource(rawUrl: string, allowedOrigin: string): Promise<SafeResource> {
  const target = await resolveAndValidateReviewTarget(rawUrl);
  const url = new URL(target.url);
  if (url.origin !== allowedOrigin) throw new Error('CROSS_ORIGIN_RESOURCE');
  const requestFunction = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<SafeResource>((resolve, reject) => {
    const request = requestFunction(url, {
      method: 'GET',
      headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'BuildPathReviewBot/0.1' },
      lookup: createPinnedLookup(target.resolvedAddresses),
    }, (response) => {
      void readResource(response, resolve, reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('CAPTURE_REQUEST_TIMEOUT')));
    request.once('error', reject);
    request.end();
  });
}

async function readResource(
  response: IncomingMessage,
  resolve: (resource: SafeResource) => void,
  reject: (error: Error) => void,
): Promise<void> {
  const status = response.statusCode ?? 0;
  const declaredSize = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESOURCE_BYTES) {
    response.destroy(new Error('CAPTURE_RESOURCE_TOO_LARGE'));
    reject(new Error('CAPTURE_RESOURCE_TOO_LARGE'));
    return;
  }
  const headers: Record<string, string> = {};
  const allowedHeaders = [
    'content-type', 'content-encoding', 'content-language', 'content-length',
    'location', 'cache-control', 'etag', 'last-modified', 'expires',
    'content-security-policy', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'permissions-policy', 'x-frame-options',
  ];
  for (const name of allowedHeaders) {
    const value = response.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESOURCE_BYTES) {
      response.destroy(new Error('CAPTURE_RESOURCE_TOO_LARGE'));
      reject(new Error('CAPTURE_RESOURCE_TOO_LARGE'));
      return;
    }
    chunks.push(buffer);
  });
  response.once('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
  response.once('error', reject);
}

function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const address = addresses[0];
  if (!address) throw new Error('NO_PUBLIC_ADDRESS');
  const family = address.includes(':') ? 6 : 4;
  type PinnedLookupCallback = {
    (error: NodeJS.ErrnoException | null, address: string, family: number): void;
    (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]): void;
  };
  return ((
    _hostname: string,
    options: number | { all?: boolean },
    callback: PinnedLookupCallback,
  ) => {
    if (typeof options === 'object' && options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}
