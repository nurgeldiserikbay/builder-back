// Sign-in with Google: OpenID Connect authorization code flow with PKCE, state and nonce.
// The ID token from Google's token endpoint is still verified here — signature against Google's published keys,
// issuer, audience, expiry and nonce — so nothing about the person is taken on trust.
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const safeUrl = (value: string) => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(value);

/**
 * On when the client id and secret are set and PUBLIC_APP_URL gives the callback address. The provider addresses can
 * be pointed elsewhere only for local tests (https, or http on localhost).
 */
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const app = env.PUBLIC_APP_URL?.trim().replace(/\/$/, '');
  if (!clientId || !clientSecret || !app || !safeUrl(`${app}/`)) return null;
  const authUrl = env.GOOGLE_OAUTH_AUTH_URL?.trim() || 'https://accounts.google.com/o/oauth2/v2/auth';
  const tokenUrl = env.GOOGLE_OAUTH_TOKEN_URL?.trim() || 'https://oauth2.googleapis.com/token';
  const jwksUrl = env.GOOGLE_OAUTH_JWKS_URL?.trim() || 'https://www.googleapis.com/oauth2/v3/certs';
  if (![authUrl, tokenUrl, jwksUrl].every(safeUrl)) return null;
  return { clientId, clientSecret, redirectUri: `${app}/api/v1/auth/google/callback`, authUrl, tokenUrl, jwksUrl };
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function authorizeUrl(config: GoogleConfig, input: { state: string; nonce: string; codeVerifier: string; locale: string }): string {
  const url = new URL(config.authUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email profile',
    state: input.state, nonce: input.nonce, code_challenge: pkceChallenge(input.codeVerifier), code_challenge_method: 'S256',
    prompt: 'select_account', hl: input.locale,
  }).toString();
  return url.toString();
}

/** Only a path inside the app: no other host, no protocol-relative «//», no backslashes. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) return '/projects';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/projects';
  return value;
}

export class GoogleAuthError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface GoogleIdentity { sub: string; email: string; emailVerified: boolean; name: string | null }

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string };
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function googleKeys(config: GoogleConfig, fetchImpl: typeof fetch, refresh = false): Promise<Jwk[]> {
  if (!refresh && jwksCache && jwksCache.url === config.jwksUrl && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const response = await fetchImpl(config.jwksUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) throw new GoogleAuthError('GOOGLE_UNAVAILABLE');
  const body = await response.json().catch(() => null) as { keys?: Jwk[] } | null;
  if (!Array.isArray(body?.keys)) throw new GoogleAuthError('GOOGLE_UNAVAILABLE');
  jwksCache = { url: config.jwksUrl, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

const decodePart = (part: string): Record<string, unknown> => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new GoogleAuthError('GOOGLE_TOKEN_INVALID'); }
};

/** Checks the ID token completely and returns who the person is. */
export async function verifyIdToken(config: GoogleConfig, idToken: string, nonce: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<GoogleIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  const header = decodePart(parts[0]!);
  const claims = decodePart(parts[1]!);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  // Google rotates its keys: an unknown key id refreshes the cache once.
  let key = (await googleKeys(config, fetchImpl)).find((item) => item.kid === header.kid);
  if (!key) key = (await googleKeys(config, fetchImpl, true)).find((item) => item.kid === header.kid);
  if (!key || key.kty !== 'RSA') throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  let valid = false;
  try {
    valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
  } catch { valid = false; }
  if (!valid) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  const seconds = Math.floor(now / 1000);
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.clientId)) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  if (typeof claims.exp !== 'number' || claims.exp < seconds - 60) throw new GoogleAuthError('GOOGLE_TOKEN_EXPIRED');
  if (typeof claims.iat === 'number' && claims.iat > seconds + 300) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  if (claims.nonce !== nonce) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 64) throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  if (typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254) throw new GoogleAuthError('GOOGLE_EMAIL_MISSING');
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 120) || null : null;
  return { sub: claims.sub, email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === 'true', name };
}

/** Trades the one-time code for tokens (with the PKCE verifier) and verifies the ID token. */
export async function exchangeCode(config: GoogleConfig, input: { code: string; codeVerifier: string; nonce: string }, fetchImpl: typeof fetch = fetch): Promise<GoogleIdentity> {
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: input.code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: input.codeVerifier }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) throw new GoogleAuthError('GOOGLE_UNAVAILABLE');
  if (!response.ok) throw new GoogleAuthError('GOOGLE_CODE_REJECTED');
  const body = await response.json().catch(() => null) as { id_token?: unknown } | null;
  if (typeof body?.id_token !== 'string') throw new GoogleAuthError('GOOGLE_TOKEN_INVALID');
  return verifyIdToken(config, body.id_token, input.nonce, fetchImpl);
}

export function resetGoogleKeyCache() { jwksCache = null; }
