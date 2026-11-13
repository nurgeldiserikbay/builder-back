import type { PrismaService } from '../database/prisma.service.js';
import { defaultQualityPolicy, parseQualityPolicy } from '../admin/quality-profiles.service.js';
import { evaluateGate, type QualityReport } from './gate.js';
import { AUDIT_VERSION, auditSite, type AuditPage } from './site-audit.js';

/** The policy builds are judged by: the default profile's active version, or the built-in default when staff set none. */
export async function activeQualityPolicy(prisma: Pick<PrismaService, 'qualityProfile'>) {
  const profile = await prisma.qualityProfile.findFirst({ where: { isDefault: true }, select: { key: true, versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1, select: { version: true, policy: true } } } });
  const version = profile?.versions[0];
  if (profile && version) {
    try { return { policy: parseQualityPolicy(version.policy), profile: { key: profile.key, version: version.version } }; } catch { /* a malformed stored policy falls back to the default */ }
  }
  return { policy: defaultQualityPolicy(), profile: null };
}

/** Audits the pages as they will be published and evaluates them against the active profile. */
export async function qualityReport(prisma: PrismaService, projectId: string, pages: AuditPage[]): Promise<QualityReport> {
  const sizes = await prisma.$queryRaw<Array<{ id: string; bytes: number }>>`SELECT id::text AS id, octet_length(data)::int AS bytes FROM project_images WHERE project_id = ${projectId}::uuid`;
  const audit = auditSite({ pages, imageBytes: Object.fromEntries(sizes.map((row) => [row.id.toLowerCase(), row.bytes])) });
  const { policy, profile } = await activeQualityPolicy(prisma);
  return evaluateGate({ ...audit, auditVersion: AUDIT_VERSION }, policy, profile);
}
