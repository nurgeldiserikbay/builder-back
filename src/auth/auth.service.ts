import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { telegramConfig, verifyWebAppInitData } from '../notifications/telegram.js';
import { emailConfig, sendEmail, type EmailConfig } from '../notifications/email.js';
import { LEGAL_VERSIONS } from '../legal/documents.js';
import { RateLimiter, authLimits } from '../security/rate-limit.js';
import { GoogleAuthError, authorizeUrl, exchangeCode, googleConfig, randomToken, safeNextPath, sha256, type GoogleIdentity } from './google-oauth.js';

const scrypt = (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Stored for accounts made with Google: never matches a password; «forgot password» can set a real one. */
const NO_PASSWORD = '!external';
/** How recent a sign-in must be to confirm a sensitive action on an account without a password. */
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  emailVerified: boolean;
  /** True when the user has not accepted the current versions of the offer and privacy policy. */
  consentRequired: boolean;
  /** True when the user has never accepted them (a new account made with Google): the app asks, not «we updated». */
  consentFirstTime: boolean;
  /** False for an account made with Google that never set a password: sensitive actions confirm by a fresh sign-in instead. */
  hasPassword: boolean;
}

type ConsentRow = { termsVersion: string; privacyVersion: string };
const latestConsent = { orderBy: { acceptedAt: 'desc' as const }, take: 1, select: { termsVersion: true, privacyVersion: true } };

export function consentIsCurrent(consent: ConsentRow | undefined): boolean {
  return Boolean(consent && consent.termsVersion === LEGAL_VERSIONS.terms && consent.privacyVersion === LEGAL_VERSIONS.privacy);
}

@Injectable()
export class AuthService {
  readonly limits = new RateLimiter();

  constructor(private readonly prisma: PrismaService) {}

  async register(input: { email: string; password: string; name?: string; locale: 'en' | 'ru' | 'kk'; acceptLegal: boolean }, ip = '') {
    if (input.acceptLegal !== true) throw new BadRequestException('CONSENT_REQUIRED');
    const normalized = input.email.trim().toLowerCase();
    const mail = this.mailConfig();
    await this.limits.take('register-ip', ip, authLimits.registerPerIp);
    await this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized: normalized } });
    // Registering again with an unconfirmed address sends a fresh link; the answer is the same either way, so it does not
    // reveal which addresses have accounts.
    if (existing) {
      if (!existing.emailVerifiedAt && !existing.deletionRequestedAt) await this.sendVerification(existing.id, existing.email).catch(() => undefined);
      return { status: 'verification_pending' as const };
    }
    await this.limits.take('mail-email', normalized, authLimits.mailPerEmail);

    const passwordHash = await this.hashPassword(input.password);
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.digest(rawToken);
    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email.trim(),
            emailNormalized: normalized,
            passwordHash,
            name: input.name?.trim() || null,
            locale: input.locale,
          },
        });
        const workspace = await tx.workspace.create({
          data: { ownerUserId: user.id, name: input.name?.trim() ? `${input.name.trim()}'s workspace` : 'My workspace' },
        });
        await tx.workspaceMember.create({
          data: { workspaceId: workspace.id, userId: user.id, role: 'owner', status: 'active' },
        });
        await tx.emailVerificationToken.create({
          data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
        });
        await tx.userConsent.create({
          data: { userId: user.id, termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, source: 'register' },
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) return { status: 'verification_pending' as const };
      throw error;
    }

    const verifyUrl = new URL('/verify-email', mail.appUrl);
    verifyUrl.searchParams.set('token', rawToken);
    try {
      const sent = await sendEmail(
        mail.email,
        input.email.trim(),
        'Verify your BuildPath account',
        `<p>Confirm your email to finish creating your BuildPath account.</p><p><a href="${verifyUrl.toString()}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
      );
      if (!sent) throw new Error('EMAIL_PROVIDER_REJECTED');
    } catch {
      const failedUser = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, select: { id: true } });
      if (failedUser) {
        await this.prisma.$transaction([
          this.prisma.emailVerificationToken.deleteMany({ where: { userId: failedUser.id } }),
          this.prisma.userConsent.deleteMany({ where: { userId: failedUser.id } }),
          this.prisma.workspaceMember.deleteMany({ where: { userId: failedUser.id } }),
          this.prisma.workspace.deleteMany({ where: { ownerUserId: failedUser.id } }),
          this.prisma.user.deleteMany({ where: { id: failedUser.id, emailVerifiedAt: null } }),
        ]);
      }
      throw new ServiceUnavailableException('EMAIL_DELIVERY_UNAVAILABLE');
    }
    return { status: 'verification_pending' as const };
  }

  /** A new confirmation link for an account that is not confirmed yet. Answers the same for unknown addresses. */
  async resendVerification(email: string, ip = ''): Promise<void> {
    const normalized = email.trim().toLowerCase();
    this.mailConfig();
    await this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, select: { id: true, email: true, emailVerifiedAt: true, deletionRequestedAt: true } });
    if (!user || user.emailVerifiedAt || user.deletionRequestedAt) return;
    await this.sendVerification(user.id, user.email);
  }

  private async sendVerification(userId: string, email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!await this.limits.allowed('mail-email', normalized, authLimits.mailPerEmail)) return;
    await this.limits.hit('mail-email', normalized, authLimits.mailPerEmail);
    const mail = this.mailConfig();
    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.emailVerificationToken.create({ data: { userId, tokenHash: this.digest(rawToken), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
    const verifyUrl = new URL('/verify-email', mail.appUrl);
    verifyUrl.searchParams.set('token', rawToken);
    const sent = await sendEmail(mail.email, email, 'Verify your BuildPath account',
      `<p>Confirm your email to finish creating your BuildPath account.</p><p><a href="${verifyUrl.toString()}">Verify email</a></p><p>This link expires in 24 hours.</p>`);
    if (!sent) throw new ServiceUnavailableException('EMAIL_DELIVERY_UNAVAILABLE');
  }

  /** «Forgot password»: mails a one-hour link. Answers the same for unknown addresses. */
  async requestPasswordReset(email: string, ip = ''): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const mail = this.mailConfig();
    await this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, select: { id: true, email: true, deletionRequestedAt: true } });
    if (!user || user.deletionRequestedAt) return;
    if (!await this.limits.allowed('mail-email', normalized, authLimits.mailPerEmail)) return;
    await this.limits.hit('mail-email', normalized, authLimits.mailPerEmail);
    const rawToken = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: this.digest(rawToken), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
    const url = new URL('/reset-password', mail.appUrl);
    url.searchParams.set('token', rawToken);
    const sent = await sendEmail(mail.email, user.email, 'Reset your BuildPath password',
      `<p>Someone asked to set a new password for your BuildPath account. If it was you, open the link:</p><p><a href="${url.toString()}">Set a new password</a></p><p>The link works for one hour. If you did not ask, ignore this email: your password stays the same.</p>`);
    if (!sent) throw new ServiceUnavailableException('EMAIL_DELIVERY_UNAVAILABLE');
  }

  /** Sets the new password, confirms the address (the link came to it) and signs out every session. */
  async resetPassword(token: string, password: string, ip = ''): Promise<void> {
    await this.limits.take('token-ip', ip, authLimits.tokenPerIp);
    const now = new Date();
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: this.digest(token) } });
    if (!record || record.consumedAt || record.expiresAt <= now) throw new UnauthorizedException('RESET_TOKEN_INVALID');
    const passwordHash = await this.hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({ where: { id: record.id, consumedAt: null }, data: { consumedAt: now } });
      if (!consumed.count) throw new UnauthorizedException('RESET_TOKEN_INVALID');
      const user = await tx.user.findUnique({ where: { id: record.userId }, select: { emailVerifiedAt: true } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, ...(user?.emailVerifiedAt ? {} : { emailVerifiedAt: now }) } });
      await tx.passwordResetToken.deleteMany({ where: { userId: record.userId, id: { not: record.id } } });
      await tx.userSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  async verifyEmail(token: string, ip = ''): Promise<void> {
    await this.limits.take('token-ip', ip, authLimits.tokenPerIp);
    const tokenHash = this.digest(token);
    const now = new Date();
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!record || record.consumedAt || record.expiresAt <= now) {
      throw new UnauthorizedException('VERIFICATION_TOKEN_INVALID');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: now } }),
      this.prisma.emailVerificationToken.update({ where: { id: record.id }, data: { consumedAt: now } }),
      this.prisma.emailVerificationToken.deleteMany({
        where: { userId: record.userId, id: { not: record.id } },
      }),
    ]);
  }

  async login(email: string, password: string, ip = ''): Promise<{ token: string; user: SafeUser }> {
    const normalized = email.trim().toLowerCase();
    await this.limits.take('login-ip', ip, authLimits.loginPerIp, 'LOGIN_RATE_LIMITED');
    if (!await this.limits.allowed('login-fail', normalized, authLimits.loginFailuresPerEmail)) throw new HttpException('LOGIN_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalized },
      include: { consents: latestConsent },
    });
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      await this.limits.hit('login-fail', normalized, authLimits.loginFailuresPerEmail);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    await this.limits.clear('login-fail', normalized);
    // Shown only after the correct password, so it does not reveal which emails have accounts.
    if (user.deletionRequestedAt) throw new ForbiddenException('ACCOUNT_DELETED');
    if (!user.emailVerifiedAt) throw new UnauthorizedException('EMAIL_NOT_VERIFIED');

    const token = randomBytes(32).toString('base64url');
    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: this.digest(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return { token, user: this.toSafeUser(user) };
  }

  /** Session for a Telegram Mini App user whose Telegram account is already linked to a verified BuildPath account. */
  async loginWithTelegramWebApp(initData: string): Promise<{ token: string; user: SafeUser }> {
    const config = telegramConfig();
    if (!config) throw new UnauthorizedException('TELEGRAM_NOT_CONFIGURED');
    const verified = verifyWebAppInitData(initData, config.token);
    if (!verified) throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
    const identity = await this.prisma.externalIdentity.findUnique({
      where: { provider_externalId: { provider: 'telegram', externalId: verified.telegramUserId } },
      include: { user: { include: { consents: latestConsent } } },
    });
    if (!identity || !identity.user.emailVerifiedAt || identity.user.deletionRequestedAt) throw new UnauthorizedException('TELEGRAM_NOT_LINKED');
    const token = randomBytes(32).toString('base64url');
    await this.prisma.userSession.create({ data: { userId: identity.userId, tokenHash: this.digest(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    return { token, user: this.toSafeUser(identity.user) };
  }

  /** Which outside sign-in methods are switched on, for the sign-in page. */
  providers() {
    return { google: Boolean(googleConfig()), telegram: Boolean(telegramConfig()) };
  }

  /**
   * Starts «Continue with Google»: a single-use state with PKCE and nonce, bound to this browser by a random value the
   * caller puts in a short cookie. Returns where to send the browser.
   */
  async startGoogle(input: { next: unknown; locale: string }, ip = ''): Promise<{ url: string; binding: string }> {
    const config = googleConfig();
    if (!config) throw new ServiceUnavailableException('GOOGLE_NOT_CONFIGURED');
    await this.limits.take('oauth-ip', ip, authLimits.oauthPerIp);
    const state = randomToken();
    const binding = randomToken();
    const codeVerifier = randomToken(48);
    const nonce = randomToken(24);
    const locale = (['en', 'ru', 'kk'] as const).find((item) => item === input.locale) ?? 'en';
    await this.prisma.oAuthLoginState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await this.prisma.oAuthLoginState.create({ data: {
      provider: 'google', stateHash: sha256(state), bindingHash: sha256(binding), codeVerifier, nonce,
      nextPath: safeNextPath(input.next), locale, expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    } });
    return { url: authorizeUrl(config, { state, nonce, codeVerifier, locale }), binding };
  }

  /**
   * Finishes the sign-in Google redirected back with. Throws GoogleAuthError with a safe code; the caller turns any error
   * into a redirect to the sign-in page.
   */
  async finishGoogle(input: { code: string | null; state: string | null; binding: string | null; error: string | null }, ip = '', fetchImpl: typeof fetch = fetch): Promise<{ token: string; next: string; created: boolean }> {
    const config = googleConfig();
    if (!config) throw new GoogleAuthError('GOOGLE_NOT_CONFIGURED');
    if (!await this.limits.allowed('oauth-ip', ip, authLimits.oauthPerIp)) throw new GoogleAuthError('LOGIN_RATE_LIMITED');
    if (!input.state || input.state.length > 100) throw new GoogleAuthError('GOOGLE_STATE_INVALID');
    const now = new Date();
    const row = await this.prisma.oAuthLoginState.findUnique({ where: { stateHash: sha256(input.state) } });
    if (!row || row.provider !== 'google' || row.consumedAt || row.expiresAt <= now) throw new GoogleAuthError('GOOGLE_STATE_INVALID');
    // Single use, whatever happens next.
    const used = await this.prisma.oAuthLoginState.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
    if (!used.count) throw new GoogleAuthError('GOOGLE_STATE_INVALID');
    // The browser that finishes must be the one that started: stops someone from signing a victim into their account.
    if (!input.binding || sha256(input.binding) !== row.bindingHash) throw new GoogleAuthError('GOOGLE_STATE_INVALID');
    if (input.error) throw new GoogleAuthError(input.error === 'access_denied' ? 'GOOGLE_CANCELLED' : 'GOOGLE_FAILED');
    if (!input.code || input.code.length > 2048) throw new GoogleAuthError('GOOGLE_FAILED');
    const identity = await exchangeCode(config, { code: input.code, codeVerifier: row.codeVerifier, nonce: row.nonce }, fetchImpl);
    const { userId, created } = await this.userForGoogle(identity, row.locale);
    const token = randomBytes(32).toString('base64url');
    await this.prisma.userSession.create({ data: { userId, tokenHash: this.digest(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    return { token, next: row.nextPath, created };
  }

  /**
   * Who signs in: the account already linked to this Google account; otherwise the account with the same address
   * (Google has confirmed it); otherwise a new account. An unconfirmed account with that address may have been made
   * by someone else, so linking it drops its password and its sessions.
   */
  private async userForGoogle(identity: GoogleIdentity, locale: string): Promise<{ userId: string; created: boolean }> {
    if (!identity.emailVerified) throw new GoogleAuthError('GOOGLE_EMAIL_NOT_VERIFIED');
    const linked = await this.prisma.externalIdentity.findUnique({ where: { provider_externalId: { provider: 'google', externalId: identity.sub } }, include: { user: true } });
    if (linked) {
      if (linked.user.deletionRequestedAt) throw new GoogleAuthError('ACCOUNT_DELETED');
      return { userId: linked.userId, created: false };
    }
    const normalized = identity.email.trim().toLowerCase();
    const now = new Date();
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, include: { externalIdentities: { where: { provider: 'google' } } } });
    if (existing) {
      if (existing.deletionRequestedAt) throw new GoogleAuthError('ACCOUNT_DELETED');
      if (existing.externalIdentities.length) throw new GoogleAuthError('GOOGLE_ACCOUNT_MISMATCH');
      await this.prisma.$transaction(async (tx) => {
        await tx.externalIdentity.create({ data: { userId: existing.id, provider: 'google', externalId: identity.sub, chatId: '' } });
        if (!existing.emailVerifiedAt) {
          await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: now, passwordHash: NO_PASSWORD, name: existing.name ?? identity.name } });
          await tx.userSession.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: now } });
          await tx.emailVerificationToken.deleteMany({ where: { userId: existing.id } });
          await tx.passwordResetToken.deleteMany({ where: { userId: existing.id } });
        }
      });
      return { userId: existing.id, created: false };
    }
    try {
      const userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: identity.email.trim(), emailNormalized: normalized, passwordHash: NO_PASSWORD, name: identity.name, locale: locale as 'en' | 'ru' | 'kk', emailVerifiedAt: now } });
        const workspace = await tx.workspace.create({ data: { ownerUserId: user.id, name: identity.name ? `${identity.name}'s workspace` : 'My workspace' } });
        await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner', status: 'active' } });
        await tx.externalIdentity.create({ data: { userId: user.id, provider: 'google', externalId: identity.sub, chatId: '' } });
        // No consent row: the app asks for the offer and privacy policy before anything else (consent gate).
        return user.id;
      });
      return { userId, created: true };
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new GoogleAuthError('GOOGLE_RETRY');
      throw error;
    }
  }

  async authenticate(token: string): Promise<{ user: SafeUser; sessionId: string }> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: this.digest(token) },
      include: { user: { include: { consents: latestConsent } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.emailVerifiedAt || session.user.deletionRequestedAt) {
      throw new UnauthorizedException('SESSION_INVALID');
    }
    return { user: this.toSafeUser(session.user), sessionId: session.id };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = (await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })) as Buffer;
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  private async verifyPassword(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1') return false;
    try {
      const salt = Buffer.from(parts[4], 'base64url');
      const expected = Buffer.from(parts[5], 'base64url');
      if (salt.length !== 16 || expected.length !== 64) return false;
      const actual = (await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })) as Buffer;
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private mailConfig(): { email: EmailConfig; appUrl: URL } {
    const email = emailConfig();
    const appBaseUrl = process.env.PUBLIC_APP_URL;
    if (!email || !appBaseUrl) throw new ServiceUnavailableException('EMAIL_DELIVERY_NOT_CONFIGURED');
    let appUrl: URL;
    try {
      appUrl = new URL(appBaseUrl);
      if (appUrl.protocol !== 'https:' && appUrl.hostname !== 'localhost') throw new Error();
    } catch {
      throw new ServiceUnavailableException('PUBLIC_APP_URL_INVALID');
    }
    return { email, appUrl };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  /** Records acceptance of the current documents; the client sends the versions it showed, so an outdated page cannot accept newer texts. */
  async acceptConsent(userId: string, versions: { termsVersion: string; privacyVersion: string }): Promise<void> {
    if (versions.termsVersion !== LEGAL_VERSIONS.terms || versions.privacyVersion !== LEGAL_VERSIONS.privacy) {
      throw new BadRequestException('LEGAL_VERSION_OUTDATED');
    }
    await this.prisma.userConsent.create({ data: { userId, ...versions, source: 'update' } });
  }

  /**
   * For an account without a password: the session must be fresh (signed in with Google within the last 15 minutes),
   * so a stolen old session cannot delete the account. Returns whether the account has a password.
   */
  async confirmWithoutPassword(userId: string, sessionId: string): Promise<'has-password' | 'fresh' | 'stale'> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || user.passwordHash !== NO_PASSWORD) return 'has-password';
    const session = await this.prisma.userSession.findUnique({ where: { id: sessionId }, select: { createdAt: true } });
    return session && Date.now() - session.createdAt.getTime() <= REAUTH_WINDOW_MS ? 'fresh' : 'stale';
  }

  /** Password check for sensitive actions such as account deletion. */
  async confirmPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    return Boolean(user && (await this.verifyPassword(password, user.passwordHash)));
  }

  async setLocale(userId: string, locale: 'en' | 'ru' | 'kk'): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { locale } });
  }

  private toSafeUser(user: { id: string; email: string; name: string | null; locale: string; emailVerifiedAt: Date | null; passwordHash: string; consents: ConsentRow[] }): SafeUser {
    return { id: user.id, email: user.email, name: user.name, locale: user.locale, emailVerified: Boolean(user.emailVerifiedAt), consentRequired: !consentIsCurrent(user.consents[0]), consentFirstTime: !user.consents.length, hasPassword: user.passwordHash !== NO_PASSWORD };
  }
}
