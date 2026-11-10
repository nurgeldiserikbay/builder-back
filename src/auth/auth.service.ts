import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { telegramConfig, verifyWebAppInitData } from '../notifications/telegram.js';
import { LEGAL_VERSIONS } from '../legal/documents.js';

const scrypt = (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

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
  constructor(private readonly prisma: PrismaService) {}

  async register(input: { email: string; password: string; name?: string; locale: 'en' | 'ru' | 'kk'; acceptLegal: boolean }) {
    if (input.acceptLegal !== true) throw new BadRequestException('CONSENT_REQUIRED');
    const normalized = input.email.trim().toLowerCase();
    const mail = this.mailConfig();
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized: normalized } });
    if (existing) return { status: 'verification_pending' as const };

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
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mail.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: mail.from,
          to: [input.email.trim()],
          subject: 'Verify your BuildPath account',
          html: `<p>Confirm your email to finish creating your BuildPath account.</p><p><a href="${verifyUrl.toString()}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('EMAIL_PROVIDER_REJECTED');
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

  async verifyEmail(token: string): Promise<void> {
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

  async login(email: string, password: string): Promise<{ token: string; user: SafeUser }> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: email.trim().toLowerCase() },
      include: { consents: latestConsent },
    });
    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
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

  private mailConfig(): { apiKey: string; from: string; appUrl: URL } {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    const appBaseUrl = process.env.PUBLIC_APP_URL;
    if (!apiKey || !from || !appBaseUrl) throw new ServiceUnavailableException('EMAIL_DELIVERY_NOT_CONFIGURED');
    let appUrl: URL;
    try {
      appUrl = new URL(appBaseUrl);
      if (appUrl.protocol !== 'https:' && appUrl.hostname !== 'localhost') throw new Error();
    } catch {
      throw new ServiceUnavailableException('PUBLIC_APP_URL_INVALID');
    }
    return { apiKey, from, appUrl };
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

  private toSafeUser(user: { id: string; email: string; name: string | null; locale: string; emailVerifiedAt: Date | null; consents: ConsentRow[] }): SafeUser {
    return { id: user.id, email: user.email, name: user.name, locale: user.locale, emailVerified: Boolean(user.emailVerifiedAt), consentRequired: !consentIsCurrent(user.consents[0]) };
  }
}
