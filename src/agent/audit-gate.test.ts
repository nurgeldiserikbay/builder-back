import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { PrismaService } from '../database/prisma.service.js';
import { auditFact, launchAudit } from './audit-gate.js';

const audit = (status: string, counts?: { critical: number; high: number }) => ({ checks: [
  { id: 'install', status: 'passed' },
  { id: 'audit', status, ...(counts ? { vulnerabilities: { ...counts, moderate: 0, low: 0, packages: [{ name: 'qs', severity: 'high', title: null }, { name: 'debug', severity: 'low', title: null }] } } : {}) },
] });

describe('audit facts', () => {
  it('reads clean, vulnerable and unchecked builds; an older task without the check says nothing', () => {
    assert.deepEqual(auditFact('t', audit('passed', { critical: 0, high: 0 })), { state: 'clean', taskId: 't' });
    assert.deepEqual(auditFact('t', audit('failed', { critical: 0, high: 1 })), { state: 'vulnerable', taskId: 't', critical: 0, high: 1, packages: ['qs'] });
    assert.deepEqual(auditFact('t', audit('skipped')), { state: 'unchecked', taskId: 't' });
    assert.equal(auditFact('t', { checks: [{ id: 'install', status: 'passed' }] }), null);
    assert.equal(auditFact('t', null), null);
  });
});

/** Against DATABASE_URL; skipped without it. */
describe('launch audit (database)', async () => {
  let prisma: PrismaService | null = null;
  try { prisma = new PrismaService(); await prisma.$queryRaw`SELECT 1 FROM agent_tasks LIMIT 1`; } catch { prisma = null; }
  const skip = prisma ? false : 'database not available';
  const users: string[] = [];
  after(async () => {
    if (!prisma) return;
    await prisma.project.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('looks at the main line when the project builds by modules, otherwise at the latest whole-application task', { skip }, async () => {
    const email = `owner-${randomUUID()}@test.local`;
    const owner = await prisma!.user.create({ data: { email, emailNormalized: email, passwordHash: 'x', emailVerifiedAt: new Date() } });
    users.push(owner.id);
    const workspace = await prisma!.workspace.create({ data: { ownerUserId: owner.id, name: 'W' } });
    const project = await prisma!.project.create({ data: { workspaceId: workspace.id, ownerUserId: owner.id, name: 'P', startMode: 'build', status: 'active', projectType: 'web_app', routeVersion: '1.0.0' } });
    const stage = await prisma!.projectStage.create({ data: { projectId: project.id, stageKey: 'handoff', definitionVersion: '1', position: 0, status: 'approved' } });
    const version = await prisma!.stageArtifactVersion.create({ data: { projectId: project.id, stageId: stage.id, versionNumber: 1, artifactType: 'handoff', content: {}, origin: 'owner_edit', createdByUserId: owner.id } });
    let at = Date.now();
    const task = (data: { kind: string; status: string; moduleKey?: string; result: unknown }) => prisma!.agentTask.create({ data: {
      projectId: project.id, kind: data.kind, status: data.status, moduleKey: data.moduleKey ?? null, profile: 'node-react-pg@1', locale: 'ru', sourceVersionId: version.id, inputVersionIds: [],
      prompt: {}, promptDigest: 'x', limits: {}, steps: [], result: data.result as never, files: [], requestedByUserId: owner.id, createdAt: new Date((at += 1000)),
    } });

    assert.equal(await launchAudit(prisma as never, project.id), null);
    await task({ kind: 'build', status: 'succeeded', result: audit('failed', { critical: 1, high: 0 }) });
    assert.equal((await launchAudit(prisma as never, project.id))?.state, 'vulnerable');
    // A failed later attempt does not hide the vulnerable code that is still the latest finished one.
    await task({ kind: 'change', status: 'failed', result: audit('passed', { critical: 0, high: 0 }) });
    assert.equal((await launchAudit(prisma as never, project.id))?.state, 'vulnerable');
    await task({ kind: 'change', status: 'succeeded', result: audit('passed', { critical: 0, high: 0 }) });
    assert.equal((await launchAudit(prisma as never, project.id))?.state, 'clean');
    // Building by modules: a module's own task is not what is launched; the main line is.
    await task({ kind: 'build', status: 'succeeded', moduleKey: 'accounts', result: audit('failed', { critical: 0, high: 3 }) });
    await task({ kind: 'line_merge', status: 'succeeded', moduleKey: 'accounts', result: audit('skipped') });
    assert.equal((await launchAudit(prisma as never, project.id))?.state, 'unchecked');
  });
});
