import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, UnauthorizedException } from '@nestjs/common';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { authLimits } from '../security/rate-limit.js';
import { legalValuesFromEnv, renderLegal, LEGAL_EFFECTIVE_DATE, LEGAL_TITLES, LEGAL_VERSIONS, type LegalDocumentKey, CONSENT_STATEMENT } from '../legal/documents.js';

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** pg_advisory_lock key so only one API instance purges at a time. */
const PURGE_LOCK_KEY = 7_316_002;

export function purgeDueAt(requestedAt: Date, retentionDays: number): Date {
  return new Date(requestedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * Account lifecycle beyond sign-in: legal documents, self-service deletion with a retention period,
 * staff restore during that period, and the final purge.
 */
@Injectable()
export class AccountService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AccountPurge');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

  onApplicationBootstrap(): void {
    if (process.env.ACCOUNT_PURGE_DISABLED === 'true') return;
    const run = () => { this.purgeDue().catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'ACCOUNT_PURGE_FAILED')); };
    this.timer = setInterval(run, PURGE_INTERVAL_MS);
    this.timer.unref();
    setTimeout(run, 30_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- settings ----

  async retentionDays(): Promise<number> {
    const row = await this.prisma.privacySettings.findUnique({ where: { id: 1 }, select: { accountRetentionDays: true } });
    return row?.accountRetentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  async settings() {
    const row = await this.prisma.privacySettings.findUnique({ where: { id: 1 } });
    const pending = await this.prisma.user.count({ where: { deletionRequestedAt: { not: null } } });
    return {
      data: {
        accountRetentionDays: row?.accountRetentionDays ?? DEFAULT_RETENTION_DAYS,
        minDays: MIN_RETENTION_DAYS,
        maxDays: MAX_RETENTION_DAYS,
        pendingDeletions: pending,
        updatedAt: row?.updatedAt ?? null,
        legalVersions: LEGAL_VERSIONS,
      },
    };
  }

  /** A new period applies to every account still waiting for deletion: purge time is always deletion date + current period. */
  async updateRetention(staffId: string, days: number) {
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) throw new BadRequestException('INVALID_RETENTION_DAYS');
    const previous = await this.retentionDays();
    if (previous !== days) {
      await this.prisma.$transaction([
        this.prisma.privacySettings.upsert({ where: { id: 1 }, create: { id: 1, accountRetentionDays: days, updatedByStaffId: staffId }, update: { accountRetentionDays: days, updatedByStaffId: staffId } }),
        this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'privacy.retention_changed', targetType: 'privacy_settings', targetId: '1', details: { previousDays: previous, nextDays: days } } }),
      ]);
    }
    return this.settings();
  }

  // ---- legal documents ----

  async legalDocument(key: LegalDocumentKey) {
    const values = legalValuesFromEnv(process.env, { accountRetentionDays: await this.retentionDays(), leadRetentionDays: leadRetentionDays() });
    return {
      data: { key, title: LEGAL_TITLES[key], version: LEGAL_VERSIONS[key], effectiveDate: LEGAL_EFFECTIVE_DATE[key], markdown: renderLegal(key, values) },
    };
  }

  consentInfo() {
    return { data: { statement: CONSENT_STATEMENT, termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy } };
  }

  // ---- self-service deletion ----

  /** What deletion will do, shown before the user confirms. */
  async deletionPreview(userId: string) {
    const [projects, liveSites, specialistStages, telegram, retention] = await Promise.all([
      this.prisma.project.count({ where: { ownerUserId: userId } }),
      this.prisma.sitePublication.findMany({ where: { status: 'live', project: { ownerUserId: userId } }, select: { slug: true, project: { select: { name: true } } } }),
      this.prisma.stageAssignment.count({ where: { userId, status: { in: ['invited', 'active'] } } }),
      this.prisma.externalIdentity.count({ where: { userId, provider: 'telegram' } }),
      this.retentionDays(),
    ]);
    return {
      data: {
        projects,
        liveSites: liveSites.map((site) => ({ slug: site.slug, projectName: site.project.name })),
        specialistStages,
        telegramLinked: telegram > 0,
        retentionDays: retention,
        purgeAfter: purgeDueAt(new Date(), retention),
      },
    };
  }

  /**
   * Immediate effects: sign-out everywhere, sites unpublished, everyone else's access to the user's projects closed,
   * the user's own specialist access closed, Telegram unlinked. Everything else waits for the retention period.
   */
  async requestDeletion(userId: string, password: string) {
    // The same limit as sign-in: a stolen session must not be able to guess the password here.
    if (!this.auth.limits.allowed('login-fail', userId, authLimits.loginFailuresPerEmail)) throw new HttpException('LOGIN_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    if (!(await this.auth.confirmPassword(userId, password))) {
      this.auth.limits.hit('login-fail', userId, authLimits.loginFailuresPerEmail);
      throw new UnauthorizedException('INVALID_PASSWORD');
    }
    const now = new Date();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailNormalized: true, deletionRequestedAt: true } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    if (user.deletionRequestedAt) return this.deletionState(userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletionRequestedAt: now } });
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.externalIdentity.deleteMany({ where: { userId } });
      await tx.telegramLinkCode.deleteMany({ where: { userId } });
      await tx.telegramChatState.deleteMany({ where: { userId } });

      const owned = await tx.project.findMany({ where: { ownerUserId: userId }, select: { id: true, status: true, publication: { select: { status: true, slug: true } } } });
      for (const project of owned) {
        if (project.publication?.status === 'live') {
          await tx.sitePublication.update({ where: { projectId: project.id }, data: { status: 'unpublished', unpublishedAt: now } });
          await tx.projectEvent.create({ data: { projectId: project.id, actorUserId: userId, type: 'site_unpublished', details: { slug: project.publication.slug, reason: 'account_deleted' } } });
        }
        if (project.status === 'live') await tx.project.update({ where: { id: project.id }, data: { status: 'active' } });
      }
      const ownedIds = owned.map((project) => project.id);
      // Specialists and members lose access to this user's projects.
      await tx.stageAssignment.updateMany({ where: { projectId: { in: ownedIds }, status: { in: ['invited', 'active', 'completed'] } }, data: { status: 'revoked', revokedAt: now, readUntil: null } });
      await tx.projectMember.updateMany({ where: { projectId: { in: ownedIds }, userId: { not: userId }, status: { in: ['invited', 'active'] } }, data: { status: 'revoked' } });
      await tx.workspaceMember.updateMany({ where: { workspace: { ownerUserId: userId }, userId: { not: userId }, status: { in: ['invited', 'active'] } }, data: { status: 'revoked' } });
      await tx.workspaceInvitation.updateMany({ where: { createdByUserId: userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });

      // This user's access as a specialist on other people's projects ends; owners see it in the project history.
      const asSpecialist = await tx.stageAssignment.findMany({
        where: { OR: [{ userId }, { email: user.emailNormalized }], projectId: { notIn: ownedIds }, status: { in: ['invited', 'active', 'completed'] } },
        select: { id: true, projectId: true, status: true, stage: { select: { stageKey: true } } },
      });
      for (const assignment of asSpecialist) {
        await tx.stageAssignment.update({ where: { id: assignment.id }, data: { status: 'revoked', revokedAt: now, readUntil: null } });
        if (assignment.status !== 'completed') {
          await tx.projectEvent.create({ data: { projectId: assignment.projectId, actorUserId: userId, type: 'specialist_account_deleted', stageKey: assignment.stage.stageKey, details: { assignmentId: assignment.id } } });
        }
      }
      await tx.projectMember.updateMany({ where: { userId, projectId: { notIn: ownedIds }, status: { in: ['invited', 'active'] } }, data: { status: 'revoked' } });
      await tx.workspaceMember.updateMany({ where: { userId, workspace: { ownerUserId: { not: userId } }, status: { in: ['invited', 'active'] } }, data: { status: 'revoked' } });
    });
    return this.deletionState(userId);
  }

  private async deletionState(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
    const retention = await this.retentionDays();
    return { data: { deletionRequestedAt: user?.deletionRequestedAt ?? null, purgeAfter: user?.deletionRequestedAt ? purgeDueAt(user.deletionRequestedAt, retention) : null, retentionDays: retention } };
  }

  // ---- staff ----

  async staffStatus(email: string) {
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() }, select: { id: true, email: true, deletionRequestedAt: true, consents: { orderBy: { acceptedAt: 'desc' }, take: 1, select: { termsVersion: true, privacyVersion: true, acceptedAt: true } } } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    const retention = await this.retentionDays();
    return {
      data: {
        userId: user.id, email: user.email,
        deletionRequestedAt: user.deletionRequestedAt,
        purgeAfter: user.deletionRequestedAt ? purgeDueAt(user.deletionRequestedAt, retention) : null,
        consent: user.consents[0] ?? null,
      },
    };
  }

  /** Cancels a pending deletion. Sites stay unpublished and specialists are not re-invited: the owner decides again. */
  async staffRestore(staffId: string, email: string) {
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: email.trim().toLowerCase() }, select: { id: true, deletionRequestedAt: true } });
    if (!user) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    if (!user.deletionRequestedAt) throw new BadRequestException('ACCOUNT_NOT_DELETED');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: null } }),
      this.prisma.workspaceMember.updateMany({ where: { userId: user.id, workspace: { ownerUserId: user.id } }, data: { status: 'active' } }),
      this.prisma.adminAuditEvent.create({ data: { staffId, eventType: 'account.deletion_cancelled', targetType: 'user', targetId: user.id, details: { requestedAt: user.deletionRequestedAt.toISOString() } } }),
    ]);
    return this.staffStatus(email);
  }

  // ---- purge ----

  /** Permanently removes accounts whose retention period has passed. Returns the number of accounts removed. */
  async purgeDue(now = new Date(), onlyUserIds?: string[]): Promise<number> {
    const retention = await this.retentionDays();
    const cutoff = new Date(now.getTime() - retention * DAY_MS);
    const locked = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${PURGE_LOCK_KEY}) AS locked`;
    if (!locked[0]?.locked) return 0;
    let removed = 0;
    try {
      const due = await this.prisma.user.findMany({ where: { deletionRequestedAt: { not: null, lte: cutoff }, ...(onlyUserIds ? { id: { in: onlyUserIds } } : {}) }, select: { id: true }, take: 50 });
      for (const user of due) {
        const keys = await this.purgeUser(user.id);
        await this.deleteStoredObjects(keys);
        removed += 1;
      }
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${PURGE_LOCK_KEY})`;
    }
    if (removed) this.logger.log(`purged ${removed} account(s)`);
    return removed;
  }

  /**
   * Deletes the user and everything they own. Review data the user wrote in other people's review runs is removed too:
   * it is the user's content. Returns object-storage keys of design files to remove after the transaction.
   */
  private async purgeUser(userId: string): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
      if (!user?.deletionRequestedAt) return [];
      const runFilter = { OR: [{ ownerUserId: userId }, { project: { ownerUserId: userId } }] };
      const sources = await tx.designSource.findMany({ where: { reviewRun: runFilter, storageKey: { not: null } }, select: { storageKey: true } });
      await tx.pageDesignMapping.deleteMany({ where: { mappingAuthorUserId: userId } });
      await tx.reviewFinding.deleteMany({ where: { authorUserId: userId } });
      await tx.reviewRequirement.deleteMany({ where: { authorUserId: userId } });
      await tx.reviewApiCheck.deleteMany({ where: { authorUserId: userId } });
      await tx.reviewRun.deleteMany({ where: runFilter });
      await tx.project.deleteMany({ where: { ownerUserId: userId } });
      await tx.workspaceInvitation.deleteMany({ where: { createdByUserId: userId } });
      await tx.workspace.deleteMany({ where: { ownerUserId: userId } });
      await tx.stageAssignment.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      return sources.map((source) => source.storageKey).filter((key): key is string => Boolean(key));
    }, { timeout: 60_000 });
  }

  private async deleteStoredObjects(keys: string[]): Promise<void> {
    const bucket = process.env.DESIGN_ASSETS_BUCKET;
    if (!keys.length || !bucket) return;
    const endpoint = process.env.DESIGN_ASSETS_ENDPOINT;
    const client = new S3Client({
      region: process.env.DESIGN_ASSETS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.DESIGN_ASSETS_PATH_STYLE === 'true',
      ...(process.env.DESIGN_ASSETS_ACCESS_KEY && process.env.DESIGN_ASSETS_SECRET_KEY
        ? { credentials: { accessKeyId: process.env.DESIGN_ASSETS_ACCESS_KEY, secretAccessKey: process.env.DESIGN_ASSETS_SECRET_KEY } } : {}),
    });
    try {
      for (const key of keys) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => this.logger.warn('design file not removed from storage'));
    } finally {
      client.destroy();
    }
  }
}

export function leadRetentionDays(): number {
  const value = Number(process.env.LEAD_RETENTION_DAYS ?? 365);
  return Number.isInteger(value) && value > 0 ? value : 365;
}
