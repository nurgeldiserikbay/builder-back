import 'dotenv/config';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from './auth.service.js';
import { authorizeUrl, googleConfig, pkceChallenge, resetGoogleKeyCache, safeNextPath, verifyIdToken, type GoogleConfig } from './google-oauth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims: Record<string, unknown>, kid = 'k1', key = privateKey) {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
const config: GoogleConfig = { clientId: 'client-1', clientSecret: 'secret', redirectUri: 'http://localhost:3000/api/v1/auth/google/callback', authUrl: 'https://accounts.example/auth', tokenUrl: 'https://oauth.example/token', jwksUrl: 'https://keys.example/certs' };
const now = Date.now();
const good = (extra: Record<string, unknown> = {}) => ({ iss: 'https://accounts.google.com', aud: 'client-1', sub: '1234567890', email: 'aigerim@example.com', email_verified: true, name: 'Айгерим', nonce: 'n1', exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000), ...extra });
const keysFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch;

describe('Google sign-in: token checks', () => {
  before(() => resetGoogleKeyCache());

  it('accepts a correct ID token and refuses every kind of wrong one', async () => {
    assert.deepEqual(await verifyIdToken(config, idToken(good()), 'n1', keysFetch, now), { sub: '1234567890', email: 'aigerim@example.com', emailVerified: true, name: 'Айгерим' });
    const reject = (token: string, code: RegExp, nonce = 'n1') => assert.rejects(verifyIdToken(config, token, nonce, keysFetch, now), code);
    await reject(idToken(good({ aud: 'someone-else' })), /GOOGLE_TOKEN_INVALID/);
    await reject(idToken(good({ iss: 'https://evil.example' })), /GOOGLE_TOKEN_INVALID/);
    await reject(idToken(good({ exp: Math.floor(now / 1000) - 3600 })), /GOOGLE_TOKEN_EXPIRED/);
    await reject(idToken(good()), /GOOGLE_TOKEN_INVALID/, 'other-nonce');
    await reject(idToken(good({ email: 'not-an-email' })), /GOOGLE_EMAIL_MISSING/);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await reject(idToken(good(), 'k1', other), /GOOGLE_TOKEN_INVALID/);
    await reject(idToken(good(), 'unknown-kid'), /GOOGLE_TOKEN_INVALID/);
    const [head, body] = idToken(good()).split('.');
    await reject(`${head}.${body}.`, /GOOGLE_TOKEN_INVALID/);
    await reject(`${b64({ alg: 'none', kid: 'k1' })}.${body}.x`, /GOOGLE_TOKEN_INVALID/);
    assert.equal((await verifyIdToken(config, idToken(good({ email_verified: false })), 'n1', keysFetch, now)).emailVerified, false);
  });

  it('builds the Google address with PKCE and keeps the way back inside the app', () => {
    const url = new URL(authorizeUrl(config, { state: 's1', nonce: 'n1', codeVerifier: 'v'.repeat(64), locale: 'ru' }));
    assert.equal(url.searchParams.get('code_challenge'), pkceChallenge('v'.repeat(64)));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', 'projects', null, '/x\n']) assert.equal(safeNextPath(bad), '/projects');
    assert.equal(safeNextPath('/projects/abc?tab=team'), '/projects/abc?tab=team');
    assert.equal(googleConfig({}), null);
    assert.equal(googleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', PUBLIC_APP_URL: 'http://evil.example' }), null);
    assert.equal(googleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'a', GOOGLE_OAUTH_CLIENT_SECRET: 'b', PUBLIC_APP_URL: 'https://app.example/' })?.redirectUri, 'https://app.example/api/v1/auth/google/callback');
  });
});

describe('Google sign-in: accounts (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT id FROM oauth_login_states LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const emails: string[] = [];
  const saved = { ...process.env };
  before(() => {
    Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: 'client-1', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', PUBLIC_APP_URL: 'http://localhost:3000', GOOGLE_OAUTH_AUTH_URL: 'https://accounts.example/auth', GOOGLE_OAUTH_TOKEN_URL: 'https://oauth.example/token', GOOGLE_OAUTH_JWKS_URL: 'https://keys.example/certs' });
    resetGoogleKeyCache();
  });
  after(async () => {
    process.env = saved;
    if (!prisma) return;
    const users = await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users.map((user) => user.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await prisma.$disconnect();
  });

  /** Starts a sign-in and answers Google's token endpoint with an ID token for these claims. */
  async function signIn(auth: AuthService, claims: Record<string, unknown>, tamper: { binding?: string; error?: string } = {}) {
    const started = await auth.startGoogle({ next: '/projects/new', locale: 'ru' });
    const url = new URL(started.url);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    let tokenRequest = '';
    const fetchImpl = (async (target: string, init?: RequestInit) => {
      if (target === 'https://keys.example/certs') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      tokenRequest = String(init?.body ?? '');
      return new Response(JSON.stringify({ id_token: idToken({ ...good({ nonce }), ...claims }) }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await auth.finishGoogle({ code: 'code-1', state, binding: tamper.binding ?? started.binding, error: tamper.error ?? null }, '', fetchImpl);
    return { result, state, binding: started.binding, tokenRequest, fetchImpl };
  }

  it('creates, links and protects accounts', { skip }, async () => {
    const auth = new AuthService(prisma!);
    const mail = (name: string) => { const email = `${name}-${randomUUID().slice(0, 8)}@test.local`; emails.push(email); return email; };

    // A new person: a verified account with a workspace, Google linked, consent still to be given.
    const newEmail = mail('new');
    const first = await signIn(auth, { sub: `g-${randomUUID()}`, email: newEmail, name: 'Новый' });
    assert.equal(first.result.created, true);
    assert.equal(first.result.next, '/projects/new');
    assert.match(first.tokenRequest, /code_verifier=/);
    const created = await prisma!.user.findUniqueOrThrow({ where: { emailNormalized: newEmail }, include: { externalIdentities: true, ownedWorkspaces: true, consents: true } });
    assert.ok(created.emailVerifiedAt);
    assert.equal(created.externalIdentities[0]!.provider, 'google');
    assert.equal(created.ownedWorkspaces.length, 1);
    assert.equal(created.consents.length, 0);
    const firstUser = (await auth.authenticate(first.result.token)).user;
    assert.equal(firstUser.consentRequired, true);
    assert.equal(firstUser.consentFirstTime, true);
    // No password: sensitive actions need a fresh sign-in instead.
    assert.equal(firstUser.hasPassword, false);
    const { sessionId } = await auth.authenticate(first.result.token);
    assert.equal(await auth.confirmWithoutPassword(firstUser.id, sessionId), 'fresh');
    await prisma!.userSession.update({ where: { id: sessionId }, data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } });
    assert.equal(await auth.confirmWithoutPassword(firstUser.id, sessionId), 'stale');
    // The password sign-in does not open a Google-only account.
    await assert.rejects(auth.login(newEmail, 'whatever-password'), /INVALID_CREDENTIALS/);
    // The state is single use.
    await assert.rejects(auth.finishGoogle({ code: 'code-1', state: first.state, binding: first.binding, error: null }, '', first.fetchImpl), /GOOGLE_STATE_INVALID/);

    // The same Google account next time: the same user.
    const sub = created.externalIdentities[0]!.externalId;
    const again = await signIn(auth, { sub, email: newEmail });
    assert.equal(again.result.created, false);
    assert.equal((await auth.authenticate(again.result.token)).user.id, created.id);

    // An unconfirmed account someone made with this address: linked, its password and sessions dropped.
    const squatted = mail('squat');
    const squatter = await prisma!.user.create({ data: { email: squatted, emailNormalized: squatted, passwordHash: 'scrypt$x', name: 'Чужой' } });
    await prisma!.userSession.create({ data: { userId: squatter.id, tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 3600_000) } });
    await signIn(auth, { sub: `g-${randomUUID()}`, email: squatted });
    const reclaimed = await prisma!.user.findUniqueOrThrow({ where: { id: squatter.id }, include: { sessions: true } });
    assert.ok(reclaimed.emailVerifiedAt);
    assert.equal(reclaimed.passwordHash, '!external');
    assert.equal(reclaimed.sessions.filter((session) => !session.revokedAt).length, 1, 'only the new Google session is active');

    // A confirmed account with the same address keeps its password and gets Google linked.
    const confirmed = mail('verified');
    const owner = await prisma!.user.create({ data: { email: confirmed, emailNormalized: confirmed, passwordHash: 'scrypt$keep', emailVerifiedAt: new Date() } });
    await signIn(auth, { sub: `g-${randomUUID()}`, email: confirmed });
    assert.equal((await prisma!.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash, 'scrypt$keep');
    // …and a second, different Google account for that address is refused.
    await assert.rejects(signIn(auth, { sub: `g-${randomUUID()}`, email: confirmed }), /GOOGLE_ACCOUNT_MISMATCH/);

    // Refusals: another browser, cancelled at Google, address not confirmed by Google, deleted account.
    await assert.rejects(signIn(auth, { sub: `g-${randomUUID()}`, email: mail('x') }, { binding: 'stolen' }), /GOOGLE_STATE_INVALID/);
    await assert.rejects(signIn(auth, { sub: `g-${randomUUID()}`, email: mail('y') }, { error: 'access_denied' }), /GOOGLE_CANCELLED/);
    await assert.rejects(signIn(auth, { sub: `g-${randomUUID()}`, email: mail('z'), email_verified: false }), /GOOGLE_EMAIL_NOT_VERIFIED/);
    await prisma!.user.update({ where: { id: owner.id }, data: { deletionRequestedAt: new Date() } });
    await assert.rejects(signIn(auth, { sub: `g-${randomUUID()}`, email: confirmed }), /ACCOUNT_DELETED/);
    assert.deepEqual(auth.providers().google, true);
  });
});
