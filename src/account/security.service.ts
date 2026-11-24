import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService, NO_PASSWORD } from '../auth/auth.service.js';
import { authLimits } from '../security/rate-limit.js';
import { describeDevice } from '../security/device.js';
import { findRecoveryCode, hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUri, verifyCode } from '../security/totp.js';
import { openSecret, sealSecret } from '../common/secret-box.js';
import { accountSecretKey } from '../security/account-key.js';
import { notifyUser } from '../notifications/user-notifier.js';
import { tr } from '../i18n/i18n.js';
import { parsePrefs, prefsOf } from './notification-prefs.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/**
 * «Безопасность» and «Уведомления» of an account: active sessions, sign-in history, two-step sign-in with an
 * authenticator app and recovery codes, and where notices go. Changes that weaken protection need the password (or a
 * fresh sign-in for accounts made with Google) and are announced by Telegram and e-mail whatever the settings.
 */
@Injectable()
export class SecurityService {
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

  async overview(userId: string, sessionId: string) {
    const now = new Date();
    const [user, sessions, events] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true, recoveryCodes: true, passwordHash: true } }),
      this.prisma.userSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: now } }, orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: 50 }),
      this.prisma.loginEvent.findMany({ where: { userId, createdAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    return {
      data: {
        twoStep: { enabled: Boolean(user.totpEnabledAt), enabledAt: user.totpEnabledAt, recoveryCodesLeft: user.totpEnabledAt ? user.recoveryCodes.length : null, available: Boolean(accountSecretKey()) },
        hasPassword: user.passwordHash !== NO_PASSWORD,
        sessions: sessions.map((session) => ({
          id: session.id, current: session.id === sessionId, device: describeDevice(session.userAgent), ipHint: session.ipHint, method: session.method,
          createdAt: session.createdAt, lastSeenAt: session.lastSeenAt ?? session.createdAt,
        })),
        signIns: events.map((event) => ({ id: event.id, at: event.createdAt, method: event.method, outcome: event.outcome, device: describeDevice(event.userAgent), ipHint: event.ipHint })),
      },
    };
  }

  async revokeSession(userId: string, sessionId: string, targetId: string) {
    if (!isUuid(targetId)) throw new NotFoundException('SESSION_NOT_FOUND');
    if (targetId === sessionId) throw new BadRequestException('USE_SIGN_OUT');
    const updated = await this.prisma.userSession.updateMany({ where: { id: targetId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (updated.count !== 1) throw new NotFoundException('SESSION_NOT_FOUND');
    return this.overview(userId, sessionId);
  }

  /** «Выйти на остальных устройствах»: every session except this one. */
  async revokeOthers(userId: string, sessionId: string) {
    await this.prisma.userSession.updateMany({ where: { userId, revokedAt: null, id: { not: sessionId } }, data: { revokedAt: new Date() } });
    return this.overview(userId, sessionId);
  }

  /** The same check as account deletion: the password (rate-limited like sign-in), or a fresh Google sign-in. */
  private async confirm(userId: string, sessionId: string, password: string | null) {
    if (password === null) {
      const state = await this.auth.confirmWithoutPassword(userId, sessionId);
      if (state === 'has-password') throw new UnauthorizedException('INVALID_PASSWORD');
      if (state === 'stale') throw new UnauthorizedException('REAUTH_REQUIRED');
      return;
    }
    if (!await this.auth.limits.allowed('login-fail', userId, authLimits.loginFailuresPerEmail)) throw new HttpException('LOGIN_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    if (!(await this.auth.confirmPassword(userId, password))) {
      await this.auth.limits.hit('login-fail', userId, authLimits.loginFailuresPerEmail);
      throw new UnauthorizedException('INVALID_PASSWORD');
    }
  }

  private key() {
    const key = accountSecretKey();
    if (!key) throw new ServiceUnavailableException('TWO_STEP_UNAVAILABLE');
    return key;
  }

  /** Step 1 of switching on: a new secret to scan. Nothing is protected yet until a code confirms it. */
  async setup(userId: string, sessionId: string, password: string | null) {
    const key = this.key();
    await this.confirm(userId, sessionId, password);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabledAt: true, passwordHash: true } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    // The code is asked after the password; accounts that sign in with Google or Telegram are protected there.
    if (user.passwordHash === NO_PASSWORD) throw new BadRequestException('TWO_STEP_NEEDS_PASSWORD');
    if (user.totpEnabledAt) throw new BadRequestException('TWO_STEP_ALREADY_ON');
    const secret = newSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: sealSecret(secret, key) } });
    return { data: { secret, otpauthUri: otpauthUri(secret, user.email) } };
  }

  /** Step 2: the first code from the app switches two-step sign-in on and gives ten recovery codes, shown once. */
  async enable(userId: string, sessionId: string, code: string) {
    const key = this.key();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpPendingSecret: true, totpEnabledAt: true } });
    if (!user?.totpPendingSecret || user.totpEnabledAt) throw new BadRequestException('TWO_STEP_NOT_STARTED');
    const secret = openSecret(user.totpPendingSecret, key);
    const step = secret ? verifyCode(secret, code, new Date(), null) : null;
    if (step === null) throw new BadRequestException('TWO_STEP_CODE_INVALID');
    const codes = newRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: codes.map(hashRecoveryCode) },
    });
    await this.announce(userId, () => tr('В вашем аккаунте BuildPath включён вход с кодом из приложения. Если это были не вы — сразу напишите в поддержку.'));
    return { data: { recoveryCodes: codes, ...(await this.overview(userId, sessionId)).data } };
  }

  /** Switching off weakens the account: the password and a current code (or a recovery code) are both needed. */
  async disable(userId: string, sessionId: string, password: string | null, code: string) {
    const key = this.key();
    await this.confirm(userId, sessionId, password);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true, recoveryCodes: true } });
    if (!user?.totpEnabledAt || !user.totpSecret) throw new BadRequestException('TWO_STEP_ALREADY_OFF');
    const secret = openSecret(user.totpSecret, key);
    const valid = (secret && verifyCode(secret, code, new Date(), user.totpLastStep) !== null) || findRecoveryCode(code, user.recoveryCodes) >= 0;
    if (!valid) throw new BadRequestException('TWO_STEP_CODE_INVALID');
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] } });
    await this.announce(userId, () => tr('В вашем аккаунте BuildPath выключен вход с кодом из приложения. Если это были не вы — смените пароль и завершите чужие сеансы.'));
    return this.overview(userId, sessionId);
  }

  /** New recovery codes; the old ones stop working. */
  async regenerateCodes(userId: string, sessionId: string, password: string | null) {
    await this.confirm(userId, sessionId, password);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
    if (!user?.totpEnabledAt) throw new BadRequestException('TWO_STEP_ALREADY_OFF');
    const codes = newRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { recoveryCodes: codes.map(hashRecoveryCode) } });
    return { data: { recoveryCodes: codes } };
  }

  async notifications(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true, email: true, externalIdentities: { where: { provider: 'telegram' }, select: { id: true } } } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    return { data: { prefs: prefsOf(user.notificationPrefs), telegramLinked: user.externalIdentities.length > 0, email: user.email } };
  }

  async setNotifications(userId: string, raw: unknown) {
    const prefs = parsePrefs(raw);
    await this.prisma.user.update({ where: { id: userId }, data: { notificationPrefs: prefs } });
    return this.notifications(userId);
  }

  private async announce(userId: string, text: () => string) {
    await notifyUser(this.prisma, userId, {
      category: 'security', text, emailSubject: () => tr('BuildPath: изменение защиты аккаунта'),
      link: { path: '/account/security', label: () => tr('Открыть настройки безопасности') },
    });
  }
}
