// Optional error reporting to Sentry or a Sentry-compatible server (for example self-hosted GlitchTip).
// Enabled only when SENTRY_DSN is set. Events never carry cookies, request bodies, query strings or user data.
import * as Sentry from '@sentry/node';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

let enabled = false;

type ScrubbableEvent = { request?: { cookies?: unknown; data?: unknown; headers?: Record<string, string>; query_string?: unknown; url?: string }; user?: unknown; breadcrumbs?: unknown };

/** Removes anything that could identify a person or a secret before an event leaves the server. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split('?')[0];
    const headers = event.request.headers ?? {};
    event.request.headers = Object.fromEntries(Object.entries(headers).filter(([key]) => ['user-agent', 'content-type', 'accept'].includes(key.toLowerCase())));
  }
  delete event.user;
  delete event.breadcrumbs;
  return event;
}

export function initErrorReporting(service: 'api' | 'sites' | 'worker', env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'development',
    release: env.APP_RELEASE?.trim() || undefined,
    serverName: service,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeSend: (event) => scrubEvent(event),
  });
  Sentry.setTag('service', service);
  enabled = true;
  process.on('unhandledRejection', (reason) => { reportError(reason); });
  return true;
}

export function reportError(error: unknown, context?: Record<string, string>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) for (const [key, value] of Object.entries(context)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}

/** Expected errors (4xx with a code for the client) are not reported; unexpected ones and 5xx are. */
export function shouldReport(error: unknown): boolean {
  return !(error instanceof HttpException) || error.getStatus() >= 500;
}

@Catch()
export class ReportingExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    if (shouldReport(exception)) {
      const request = host.getType() === 'http' ? host.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>() : null;
      reportError(exception, request ? { method: request.method ?? '', route: request.route?.path ?? 'unknown' } : undefined);
    }
    super.catch(exception, host);
  }
}
