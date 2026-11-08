import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { StaffAuthService } from './staff-auth.service.js';
import type { StaffIdentity } from './staff-auth.service.js';

const CATEGORY_IDS = ['security', 'accessibility', 'performance', 'seo'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type Category = typeof CATEGORY_IDS[number];
type Severity = typeof SEVERITIES[number];
export type QualityPolicy = {
  schemaVersion: 1;
  minimumRequirementCoverage: number;
  blockingSeverities: Severity[];
  categories: Record<Category, { enabled: boolean; required: boolean; maxOpenCritical: number; maxOpenHigh: number }>;
};

export function defaultQualityPolicy(): QualityPolicy {
  return {
    schemaVersion: 1,
    minimumRequirementCoverage: 100,
    blockingSeverities: ['critical', 'high'],
    categories: Object.fromEntries(CATEGORY_IDS.map((id) => [id, { enabled: true, required: true, maxOpenCritical: 0, maxOpenHigh: 0 }])) as QualityPolicy['categories'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}
function integerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}
export function parseQualityPolicy(value: unknown): QualityPolicy {
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion', 'minimumRequirementCoverage', 'blockingSeverities', 'categories'])) throw new BadRequestException('INVALID_QUALITY_POLICY');
  if (value.schemaVersion !== 1 || !integerIn(value.minimumRequirementCoverage, 0, 100)) throw new BadRequestException('INVALID_QUALITY_POLICY');
  if (!Array.isArray(value.blockingSeverities) || value.blockingSeverities.some((item) => typeof item !== 'string' || !SEVERITIES.includes(item as Severity)) || new Set(value.blockingSeverities).size !== value.blockingSeverities.length) throw new BadRequestException('INVALID_QUALITY_POLICY');
  if (!isRecord(value.categories) || Object.keys(value.categories).length !== CATEGORY_IDS.length || CATEGORY_IDS.some((id) => !(id in value.categories!))) throw new BadRequestException('INVALID_QUALITY_POLICY');
  const categories = {} as QualityPolicy['categories'];
  for (const id of CATEGORY_IDS) {
    const rule = value.categories[id];
    if (!isRecord(rule) || !onlyKeys(rule, ['enabled', 'required', 'maxOpenCritical', 'maxOpenHigh'])) throw new BadRequestException('INVALID_QUALITY_POLICY');
    if (typeof rule.enabled !== 'boolean' || typeof rule.required !== 'boolean' || (rule.required && !rule.enabled) || !integerIn(rule.maxOpenCritical, 0, 100) || !integerIn(rule.maxOpenHigh, 0, 100)) throw new BadRequestException('INVALID_QUALITY_POLICY');
    categories[id] = { enabled: rule.enabled, required: rule.required, maxOpenCritical: rule.maxOpenCritical, maxOpenHigh: rule.maxOpenHigh };
  }
  return {
    schemaVersion: 1,
    minimumRequirementCoverage: value.minimumRequirementCoverage,
    blockingSeverities: value.blockingSeverities as Severity[],
    categories,
  };
}

function slug(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return base || `profile-${randomBytes(4).toString('hex')}`;
}
function safeVersion(version: { version: number; status: string; policy: unknown; createdAt: Date; activatedAt: Date | null; authoredBy?: { displayName: string } }) {
  return {
    version: version.version,
    status: version.status,
    policy: parseQualityPolicy(version.policy),
    createdAt: version.createdAt.toISOString(),
    activatedAt: version.activatedAt?.toISOString() ?? null,
    authoredBy: version.authoredBy?.displayName ?? null,
  };
}

@Injectable()
export class QualityProfilesService {
  constructor(private readonly prisma: PrismaService, private readonly auth: StaffAuthService) {}

  async list() {
    const profiles = await this.prisma.qualityProfile.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { displayName: true } }, versions: { orderBy: { version: 'desc' }, include: { authoredBy: { select: { displayName: true } } } } },
    });
    return { data: profiles.map((profile) => ({
      key: profile.key,
      name: profile.name,
      description: profile.description,
      createdAt: profile.createdAt.toISOString(),
      createdBy: profile.createdBy.displayName,
      versions: profile.versions.map(safeVersion),
    })) };
  }

  async get(profileKey: string) {
    const profile = await this.prisma.qualityProfile.findUnique({
      where: { key: profileKey },
      include: { createdBy: { select: { displayName: true } }, versions: { orderBy: { version: 'desc' }, include: { authoredBy: { select: { displayName: true } } } } },
    });
    if (!profile) throw new NotFoundException('QUALITY_PROFILE_NOT_FOUND');
    return { data: {
      key: profile.key,
      name: profile.name,
      description: profile.description,
      createdAt: profile.createdAt.toISOString(),
      createdBy: profile.createdBy.displayName,
      versions: profile.versions.map(safeVersion),
    } };
  }

  async create(input: { name: string; description: string; policy: QualityPolicy }, staff: StaffIdentity) {
    const key = slug(input.name);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.qualityProfile.create({ data: { key, name: input.name, description: input.description, createdByStaffId: staff.id } });
        const version = await tx.qualityProfileVersion.create({ data: {
          profileId: profile.id, version: 1, status: 'draft', policy: JSON.parse(JSON.stringify(input.policy)),
          authoredByStaffId: staff.id,
        }, include: { authoredBy: { select: { displayName: true } } } });
        await tx.adminAuditEvent.create({ data: { staffId: staff.id, eventType: 'quality_profile.created', targetType: 'quality_profile', targetId: profile.key } });
        await tx.adminAuditEvent.create({ data: { staffId: staff.id, eventType: 'quality_profile.version_created', targetType: 'quality_profile', targetId: `${profile.key}:1`, details: JSON.parse(JSON.stringify({ version: 1, policy: input.policy })) } });
        return { profile, version };
      });
      return { data: { key: created.profile.key, name: created.profile.name, description: created.profile.description, version: safeVersion(created.version) } };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002') throw new ConflictException('QUALITY_PROFILE_KEY_ALREADY_EXISTS');
      throw error;
    }
  }

  async createVersion(profileKey: string, staff: StaffIdentity) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.qualityProfile.findUnique({ where: { key: profileKey }, include: { versions: { orderBy: { version: 'desc' } } } });
      if (!profile) throw new NotFoundException('QUALITY_PROFILE_NOT_FOUND');
      if (profile.versions.some((item) => item.status === 'draft')) throw new ConflictException('QUALITY_PROFILE_DRAFT_ALREADY_EXISTS');
      const version = (profile.versions[0]?.version ?? 0) + 1;
      const prior = profile.versions.find((item) => item.status === 'active') ?? profile.versions[0];
      const policy = prior ? parseQualityPolicy(prior.policy) : defaultQualityPolicy();
      const draft = await tx.qualityProfileVersion.create({ data: { profileId: profile.id, version, status: 'draft', policy: JSON.parse(JSON.stringify(policy)), authoredByStaffId: staff.id }, include: { authoredBy: { select: { displayName: true } } } });
      await tx.adminAuditEvent.create({ data: { staffId: staff.id, eventType: 'quality_profile.version_created', targetType: 'quality_profile', targetId: `${profile.key}:${version}`, details: JSON.parse(JSON.stringify({ version, copiedFromVersion: prior?.version ?? null })) } });
      return { data: { key: profile.key, version: safeVersion(draft) } };
    });
  }

  async updateDraft(profileKey: string, versionNumber: number, input: { policy: QualityPolicy }, staff: StaffIdentity) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.qualityProfile.findUnique({ where: { key: profileKey } });
      if (!profile) throw new NotFoundException('QUALITY_PROFILE_NOT_FOUND');
      const existing = await tx.qualityProfileVersion.findUnique({ where: { profileId_version: { profileId: profile.id, version: versionNumber } } });
      if (!existing) throw new NotFoundException('QUALITY_PROFILE_VERSION_NOT_FOUND');
      if (existing.status !== 'draft') throw new ConflictException('QUALITY_PROFILE_VERSION_IS_NOT_DRAFT');
      const result = await tx.qualityProfileVersion.updateMany({
        where: { profileId: profile.id, version: versionNumber, status: 'draft' },
        data: { policy: JSON.parse(JSON.stringify(input.policy)), authoredByStaffId: staff.id },
      });
      if (result.count !== 1) throw new ConflictException('QUALITY_PROFILE_VERSION_IS_NOT_DRAFT');
      await tx.adminAuditEvent.create({ data: {
        staffId: staff.id, eventType: 'quality_profile.version_updated', targetType: 'quality_profile', targetId: `${profile.key}:${versionNumber}`,
        details: JSON.parse(JSON.stringify({ before: existing.policy, after: input.policy })),
      } });
      const version = await tx.qualityProfileVersion.findUniqueOrThrow({ where: { profileId_version: { profileId: profile.id, version: versionNumber } }, include: { authoredBy: { select: { displayName: true } } } });
      return { data: safeVersion(version) };
    });
  }

  async activate(profileKey: string, versionNumber: number, staff: StaffIdentity) {
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.qualityProfile.findUnique({ where: { key: profileKey } });
      if (!profile) throw new NotFoundException('QUALITY_PROFILE_NOT_FOUND');
      const target = await tx.qualityProfileVersion.findUnique({ where: { profileId_version: { profileId: profile.id, version: versionNumber } } });
      if (!target) throw new NotFoundException('QUALITY_PROFILE_VERSION_NOT_FOUND');
      if (target.status === 'active') return { data: safeVersion(target) };
      const previous = await tx.qualityProfileVersion.findFirst({ where: { profileId: profile.id, status: 'active' } });
      await tx.qualityProfileVersion.updateMany({ where: { profileId: profile.id, status: 'active' }, data: { status: 'retired' } });
      const updated = await tx.qualityProfileVersion.updateMany({
        where: { profileId: profile.id, version: versionNumber, status: { in: ['draft', 'retired'] } },
        data: { status: 'active', activatedAt: new Date() },
      });
      if (updated.count !== 1) throw new ConflictException('QUALITY_PROFILE_VERSION_CANNOT_BE_ACTIVATED');
      await tx.adminAuditEvent.create({ data: { staffId: staff.id, eventType: 'quality_profile.version_activated', targetType: 'quality_profile', targetId: `${profile.key}:${versionNumber}`, details: JSON.parse(JSON.stringify({ previousActiveVersion: previous?.version ?? null, activatedVersion: versionNumber })) } });
      const version = await tx.qualityProfileVersion.findUniqueOrThrow({ where: { profileId_version: { profileId: profile.id, version: versionNumber } }, include: { authoredBy: { select: { displayName: true } } } });
      return { data: safeVersion(version) };
    });
  }
}
