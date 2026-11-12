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

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  emailVerified: boolean;
  /** True when the user has not accepted the current versions of the offer and privacy policy. */
  consentRequired: boolean;
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
    this.limits.take('register-ip', ip, authLimits.registerPerIp);
    this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized: normalized } });
    // Registering again with an unconfirmed address sends a fresh link; the answer is the same either way, so it does not
    // reveal which addresses have accounts.
    if (existing) {
      if (!existing.emailVerifiedAt && !existing.deletionRequestedAt) await this.sendVerification(existing.id, existing.email).catch(() => undefined);
      return { status: 'verification_pending' as const };
    }
    this.limits.take('mail-email', normalized, authLimits.mailPerEmail);

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
    this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, select: { id: true, email: true, emailVerifiedAt: true, deletionRequestedAt: true } });
    if (!user || user.emailVerifiedAt || user.deletionRequestedAt) return;
    await this.sendVerification(user.id, user.email);
  }

  private async sendVerification(userId: string, email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!this.limits.allowed('mail-email', normalized, authLimits.mailPerEmail)) return;
    this.limits.hit('mail-email', normalized, authLimits.mailPerEmail);
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
    this.limits.take('mail-ip', ip, authLimits.mailPerIp);
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: normalized }, select: { id: true, email: true, deletionRequestedAt: true } });
    if (!user || user.deletionRequestedAt) return;
    if (!this.limits.allowed('mail-email', normalized, authLimits.mailPerEmail)) return;
    this.limits.hit('mail-email', normalized, authLimits.mailPerEmail);
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
    this.limits.take('token-ip', ip, authLimits.tokenPerIp);
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
    this.limits.take('token-ip', ip, authLimits.tokenPerIp);
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
    this.limits.take('login-ip', ip, authLimits.loginPerIp, 'LOGIN_RATE_LIMITED');
    if (!this.limits.allowed('login-fail', normalized, authLimits.loginFailuresPerEmail)) throw new HttpException('LOGIN_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalized },
      include: { consents: latestConsent },
    });
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      this.limits.hit('login-fail', normalized, authLimits.loginFailuresPerEmail);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    this.limits.clear('login-fail', normalized);
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

  /** Password check for sensitive actions such as account deletion. */
  async confirmPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    return Boolean(user && (await this.verifyPassword(password, user.passwordHash)));
  }

  async setLocale(userId: string, locale: 'en' | 'ru' | 'kk'): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { locale } });
  }

  private toSafeUser(user: { id: string; email: string; name: string | null; locale: string; emailVerifiedAt: Date | null; consents: ConsentRow[] }): SafeUser {
    return { id: user.id, email: user.email, name: user.name, locale: user.locale, emailVerified: Boolean(user.emailVerifiedAt), consentRequired: !consentIsCurrent(user.consents[0]) };
  }
}
