import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { defaultQualityPolicy } from '../admin/quality-profiles.service.js';
import { ProjectProfileService } from './project-profile.js';
import { qualityReport } from './quality.js';

/** A project's own quality profile — against DATABASE_URL; skipped without it. */
describe('project quality profile (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT quality_profile_key FROM projects LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  let staffId = '';
  const keys: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.qualityProfile.deleteMany({ where: { key: { in: keys } } });
    if (staffId) await prisma.staffAccount.deleteMany({ where: { id: staffId } });
    await prisma.$disconnect();
  });

  it('owner picks an active profile; builds are judged by it; a viewer cannot change it', { skip }, async () => {
    const service = new ProjectProfileService(prisma!);
    const user = async (label: string) => { const email = `${label}-${randomUUID()}@test.local`; const row = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', name: label } }); users.push(row.id); return row; };
    const owner = await user('owner');
    const viewer = await user('viewer');
    const staffEmail = `staff-${randomUUID()}@test.local`;
    staffId = (await prisma!.staffAccount.create({ data: { email: staffEmail, emailNormalized: staffEmail, passwordHash: 'x', displayName: 'S', role: 'super_admin' } })).id;
    const key = `strict-${randomUUID().slice(0, 8)}`; const draftKey = `${key}-draft`;
    keys.push(key, draftKey);
    const strict = await prisma!.qualityProfile.create({ data: { key, name: 'Строгий', description: 'Для госзаказа', createdByStaffId: staffId } });
    await prisma!.qualityProfileVersion.create({ data: { profileId: strict.id, version: 1, status: 'active', policy: defaultQualityPolicy() as never, authoredByStaffId: staffId, activatedAt: new Date() } });
    await prisma!.qualityProfile.create({ data: { key: draftKey, name: 'Черновик', description: '', createdByStaffId: staffId } });
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'landing' } });
    await prisma!.projectMember.createMany({ data: [{ projectId: project.id, userId: owner.id, role: 'owner' }, { projectId: project.id, userId: viewer.id, role: 'viewer' }] });

    const before = await service.get(owner.id, project.id);
    assert.equal(before.data.chosen, null);
    assert.ok(before.data.options.some((item) => item.key === key));
    assert.ok(!before.data.options.some((item) => item.key === draftKey));
    await assert.rejects(service.set(viewer.id, project.id, key), /QUALITY_PROFILE_FORBIDDEN/);
    await assert.rejects(service.set(owner.id, project.id, draftKey), /QUALITY_PROFILE_NOT_FOUND/);
    const after = await service.set(owner.id, project.id, key);
    assert.equal(after.data.effective?.key, key);
    const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title><meta name="description" content="d"></head><body><main><h1>T</h1></main></body></html>';
    const report = await qualityReport(prisma!, project.id, [{ path: '/', html }]);
    assert.deepEqual(report.profile, { key, version: 1 });
    await service.set(owner.id, project.id, null);
    assert.notEqual((await qualityReport(prisma!, project.id, [{ path: '/', html }])).profile?.key, key);
  });
});
