import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { consentIsCurrent } from '../auth/auth.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { RateLimiter } from '../security/rate-limit.js';
import { LEGAL_VERSIONS, legalValuesFromEnv, legalDetailsMissing, renderLegal } from '../legal/documents.js';
import { PrismaService } from '../database/prisma.service.js';
import { AccountService, purgeDueAt } from './account.service.js';

describe('legal documents', () => {
  const values = legalValuesFromEnv({ LEGAL_OPERATOR_NAME: 'ТОО «Тест»', LEGAL_SUPPORT_EMAIL: 'help@example.kz', PUBLIC_APP_URL: 'https://buildpath.kz', SITES_BASE_DOMAIN: 'buildpath.site' }, { accountRetentionDays: 45, leadRetentionDays: 365 });
  it('fills every placeholder', () => {
    for (const key of ['terms', 'privacy'] as const) {
      const text = renderLegal(key, values);
      assert.doesNotMatch(text, /\{\{/, key);
      assert.match(text, new RegExp(`Редакция ${LEGAL_VERSIONS[key].replace('.', '\\.')}`));
    }
  });
  it('shows the current retention period and company details', () => {
    const privacy = renderLegal('privacy', values);
    assert.match(privacy, /ещё 45 дн\./);
    assert.match(privacy, /ТОО «Тест»/);
    assert.match(privacy, /buildpath\.kz/);
    assert.match(privacy, /не превышает 90 дней/);
    assert.match(renderLegal('terms', values), /через 45 дн\./);
  });
  it('marks missing company details instead of inventing them', () => {
    assert.match(renderLegal('terms', values), /БИН \[будет указано\]/);
    assert.deepEqual(legalDetailsMissing({ LEGAL_OPERATOR_NAME: 'x' }).includes('LEGAL_OPERATOR_BIN'), true);
  });
  it('requires both current versions', () => {
    assert.equal(consentIsCurrent(undefined), false);
    assert.equal(consentIsCurrent({ termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy }), true);
    assert.equal(consentIsCurrent({ termsVersion: '0.9', privacyVersion: LEGAL_VERSIONS.privacy }), false);
  });
  it('purges after the period', () => {
    assert.equal(purgeDueAt(new Date('2026-11-10T00:00:00Z'), 30).toISOString(), '2026-12-10T00:00:00.000Z');
  });
});

/** Runs against the database from DATABASE_URL (use a development database); skipped when it is not reachable. Purges only accounts it created. */
describe('account deletion (database)', async () => {
  let prisma: PrismaService | null = null;
  try {
    prisma = new PrismaService();
    await prisma.$queryRaw`SELECT 1 FROM user_consents LIMIT 1`;
  } catch {
    prisma = null;
  }
  const skip = prisma ? false : 'database not available';
  const ids: string[] = [];
  const auth = { limits: new RateLimiter(), confirmPassword: async (_userId: string, password: string) => password === 'correct-password' } as unknown as AuthService;
  const service = prisma ? new AccountService(prisma, auth) : null;

  async function user(label: string) {
    const email = `${label}-${randomUUID()}@test.local`;
    const created = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date() } });
    ids.push(created.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: created.id, name: 'W' } });
    await prisma!.workspaceMember.create({ data: { workspaceId: workspace.id, userId: created.id, role: 'owner' } });
    return { ...created, workspaceId: workspace.id };
  }
  async function project(owner: { id: string; workspaceId: string }) {
    const created = await prisma!.project.create({ data: { workspaceId: owner.workspaceId, ownerUserId: owner.id, name: 'Торты', startMode: 'build', status: 'live' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: created.id, stageKey: 'content', definitionVersion: '1', position: 1, status: 'in_progress' } });
    await prisma!.sitePublication.create({ data: { projectId: created.id, slug: `t-${randomUUID().slice(0, 8)}`, status: 'live', buildVersionId: randomUUID(), publishedAt: new Date(), publishedByUserId: owner.id } });
    return { ...created, stageId: stage.id };
  }
  async function assign(projectId: string, stageId: string, specialist: { id: string; email: string }, invitedBy: string) {
    return prisma!.stageAssignment.create({ data: { projectId, stageId, userId: specialist.id, email: specialist.email, role: 'lead', status: 'active', inviteTokenHash: randomUUID().replace(/-/g, ''), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: invitedBy } });
  }

  let staffId = '';
  before(async () => {
    if (!prisma) return;
    await prisma.privacySettings.deleteMany({});
    const email = `staff-${randomUUID()}@test.local`;
    staffId = (await prisma.staffAccount.create({ data: { email, emailNormalized: email, passwordHash: 'x', displayName: 'Test', role: 'super_admin' } })).id;
  });
  after(async () => {
    if (!prisma) return;
    for (const id of ids) {
      await prisma.project.deleteMany({ where: { ownerUserId: id } }).catch(() => undefined);
      await prisma.workspace.deleteMany({ where: { ownerUserId: id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.privacySettings.deleteMany({});
    await prisma.adminAuditEvent.deleteMany({ where: { staffId } });
    await prisma.staffAccount.deleteMany({ where: { id: staffId } });
    await prisma.$disconnect();
  });

  it('rejects a wrong password and changes nothing', { skip }, async () => {
    const owner = await user('owner');
    await assert.rejects(service!.requestDeletion(owner.id, 'wrong'), /INVALID_PASSWORD/);
    assert.equal((await prisma!.user.findUnique({ where: { id: owner.id } }))!.deletionRequestedAt, null);
  });

  it('closes access and unpublishes immediately, keeps data, then purges after the period', { skip }, async () => {
    const owner = await user('owner');
    const specialist = await user('specialist');
    const other = await user('other');
    const own = await project(owner);
    const foreign = await project(other);
    const helper = await assign(own.id, own.stageId, specialist, owner.id);
    const asSpecialist = await assign(foreign.id, foreign.stageId, owner, other.id);
    await prisma!.userSession.create({ data: { userId: owner.id, tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma!.externalIdentity.create({ data: { userId: owner.id, provider: 'telegram', externalId: randomUUID().slice(0, 12), chatId: '1' } });

    const preview = (await service!.deletionPreview(owner.id)).data;
    assert.equal(preview.projects, 1);
    assert.equal(preview.liveSites.length, 1);
    assert.equal(preview.specialistStages, 1);
    assert.equal(preview.telegramLinked, true);
    assert.equal(preview.retentionDays, 30);

    const result = (await service!.requestDeletion(owner.id, 'correct-password')).data;
    assert.ok(result.deletionRequestedAt);

    assert.equal((await prisma!.userSession.count({ where: { userId: owner.id, revokedAt: null } })), 0);
    assert.equal((await prisma!.externalIdentity.count({ where: { userId: owner.id } })), 0);
    assert.equal((await prisma!.sitePublication.findUnique({ where: { projectId: own.id } }))!.status, 'unpublished');
    assert.equal((await prisma!.project.findUnique({ where: { id: own.id } }))!.status, 'active');
    assert.equal((await prisma!.stageAssignment.findUnique({ where: { id: helper.id } }))!.status, 'revoked');
    assert.equal((await prisma!.stageAssignment.findUnique({ where: { id: asSpecialist.id } }))!.status, 'revoked');
    assert.equal(await prisma!.projectEvent.count({ where: { projectId: foreign.id, type: 'specialist_account_deleted' } }), 1);
    // The other owner's site is untouched.
    assert.equal((await prisma!.sitePublication.findUnique({ where: { projectId: foreign.id } }))!.status, 'live');

    // Still within the period: nothing is purged.
    assert.equal(await service!.purgeDue(new Date(Date.now() + 29 * 86_400_000), ids), 0);
    assert.ok(await prisma!.project.findUnique({ where: { id: own.id } }));

    // A shorter period set in the admin console applies to pending deletions too.
    await assert.rejects(service!.updateRetention(staffId, 91), /INVALID_RETENTION_DAYS/);
    await service!.updateRetention(staffId, 7);
    assert.equal(await prisma!.adminAuditEvent.count({ where: { staffId, eventType: 'privacy.retention_changed' } }), 1);
    assert.equal(await service!.purgeDue(new Date(Date.now() + 8 * 86_400_000), ids), 1);
    assert.equal(await prisma!.user.findUnique({ where: { id: owner.id } }), null);
    assert.equal(await prisma!.project.findUnique({ where: { id: own.id } }), null);
    assert.equal(await prisma!.workspace.count({ where: { ownerUserId: owner.id } }), 0);
    // Specialist and the other owner keep their accounts and projects.
    assert.ok(await prisma!.user.findUnique({ where: { id: specialist.id } }));
    assert.ok(await prisma!.project.findUnique({ where: { id: foreign.id } }));
    assert.equal(await prisma!.stageAssignment.count({ where: { id: asSpecialist.id } }), 0);
  });

  it('can be cancelled by staff during the period', { skip }, async () => {
    const owner = await user('restore');
    await service!.requestDeletion(owner.id, 'correct-password');
    const status = (await service!.staffRestore(staffId, owner.email)).data;
    assert.equal(status.deletionRequestedAt, null);
    assert.equal(await service!.purgeDue(new Date(Date.now() + 365 * 86_400_000), ids), 0);
    assert.ok(await prisma!.user.findUnique({ where: { id: owner.id } }));
  });
});
