// Cross-site request forgery guard for the cookie-authenticated API.
//
// The session cookie is SameSite=Lax. That stops other sites, but not other hosts of the same
// registrable domain: published customer sites live at <slug>.<SITES_BASE_DOMAIN>, a subdomain of
// the platform's own domain, so for the browser they are "same-site" and Lax cookies ride along.
// Every state-changing request therefore has to come from an allowed origin.
//
// Rules for POST/PUT/PATCH/DELETE:
// - an Origin header must be one of the allowed origins or the request's own origin;
// - without Origin, Sec-Fetch-Site must not be "cross-site" or "same-site";
// - a request with neither header is not from a browser page (curl, server callbacks) and passes:
//   it cannot carry a victim's cookie by accident.
// Server-to-server callbacks that authenticate by signature are exempt.

export interface OriginRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Host the client used (X-Forwarded-Host behind a trusted proxy). */
  host?: string;
  protocol?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT = [/^\/api\/v1\/telegram\/webhook$/, /^\/api\/v1\/payments\/freedompay\/result$/];

function header(request: OriginRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Origins allowed to make state-changing calls: CORS_ORIGINS, PUBLIC_APP_URL and ADMIN_PUBLIC_URL. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const values = [
    ...(env.CORS_ORIGINS ?? '').split(','),
    env.PUBLIC_APP_URL ?? '',
    env.ADMIN_PUBLIC_URL ?? '',
  ];
  return new Set(values.map((value) => originOf(value.trim())).filter((value): value is string => Boolean(value)));
}

/** Null when the request may go on, otherwise the refusal code. */
export function originRefusal(request: OriginRequest, allowed: Set<string>): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const path = request.path.split('?')[0] ?? '';
  if (EXEMPT.some((pattern) => pattern.test(path))) return null;

  const rawOrigin = header(request, 'origin');
  if (rawOrigin !== undefined) {
    const origin = originOf(rawOrigin);
    if (!origin) return 'ORIGIN_NOT_ALLOWED';
    if (allowed.has(origin)) return null;
    // Same origin as the request itself (the app and the API behind one host, the admin console on its own host).
    if (request.host && origin === originOf(`${request.protocol ?? 'https'}://${request.host}`)) return null;
    if (request.host && new URL(origin).host === request.host) return null;
    return 'ORIGIN_NOT_ALLOWED';
  }

  const site = header(request, 'sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return 'ORIGIN_NOT_ALLOWED';
  return null;
}
