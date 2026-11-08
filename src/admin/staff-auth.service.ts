import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';

const scrypt = (password: string, salt: Buffer, length: number): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCallback(password, salt, length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const DUMMY_HASH = 'scrypt$Y2VydGFpbmx5LW5vdC1hLXNlY3JldA$Y0ZVaGF1aHZkUVFXUTlKeGtRSjRqQUdwMmNubHhFaEx4L1hKOVlpbTZrYw';

export type StaffRole = 'super_admin' | 'quality_admin' | 'operations_auditor';
export type StaffIdentity = { id: string; email: string; displayName: string; role: StaffRole };

@Injectable()
export class StaffAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    const identifierHash = this.digest(normalized);
    const since = new Date(Date.now() - WINDOW_MS);
    const failures = await this.prisma.staffLoginAttempt.count({ where: { identifierHash, createdAt: { gte: since } } });
    if (failures >= MAX_FAILURES) throw new HttpException('STAFF_LOGIN_RATE_LIMITED', 429);

    const account = await this.prisma.staffAccount.findUnique({ where: { emailNormalized: normalized } });
    const passwordMatches = await this.verify(password, account?.passwordHash ?? DUMMY_HASH);
    if (!account || account.status !== 'active' || !passwordMatches) {
      await this.prisma.$transaction([
        this.prisma.staffLoginAttempt.create({ data: { identifierHash } }),
        this.prisma.adminAuditEvent.create({ data: { eventType: 'staff.login_failed', targetType: 'staff_identifier', targetId: identifierHash } }),
      ]);
      throw new UnauthorizedException('INVALID_STAFF_CREDENTIALS');
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.digest(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffLoginAttempt.deleteMany({ where: { identifierHash } });
      await tx.staffSession.create({ data: { tokenHash, staffId: account.id, expiresAt } });
      await tx.adminAuditEvent.create({ data: { staffId: account.id, eventType: 'staff.login_succeeded' } });
    });
    return { token: rawToken, expiresAt, staff: this.toIdentity(account) };
  }

  async authenticate(rawToken: string | undefined): Promise<{ staff: StaffIdentity; sessionId: string } | null> {
    if (!rawToken || rawToken.length > 128) return null;
    const session = await this.prisma.staffSession.findUnique({
      where: { tokenHash: this.digest(rawToken) },
      include: { staff: true },
    });
    if (!session || session.expiresAt <= new Date() || session.staff.status !== 'active') return null;
    return { staff: this.toIdentity(session.staff), sessionId: session.id };
  }

  async logout(sessionId: string, staff: StaffIdentity): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.staffSession.deleteMany({ where: { id: sessionId } }),
      this.prisma.adminAuditEvent.create({ data: { staffId: staff.id, eventType: 'staff.logout' } }),
    ]);
  }

  async recordDenied(staff: StaffIdentity, eventType: string): Promise<void> {
    await this.prisma.adminAuditEvent.create({ data: { staffId: staff.id, eventType } });
  }

  private async verify(password: string, stored: string): Promise<boolean> {
    const [algorithm, saltText, keyText] = stored.split('$');
    if (algorithm !== 'scrypt' || !saltText || !keyText) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(keyText, 'base64url');
    const actual = await scrypt(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private toIdentity(account: { id: string; email: string; displayName: string; role: string }): StaffIdentity {
    return { id: account.id, email: account.email, displayName: account.displayName, role: account.role as StaffRole };
  }

  private digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }
}
