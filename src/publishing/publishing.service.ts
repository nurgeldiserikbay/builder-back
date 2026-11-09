import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { SiteArtifact } from '../journey/artifacts.js';
import { emailConfig } from '../notifications/email.js';
import { telegramConfig } from '../notifications/telegram.js';
import { sitesConfig, slugProblem, suggestSlug } from './slug.js';

const manageRoles = new Set(['owner', 'manager']);

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Injectable()
export class PublishingService {
  constructor(private readonly prisma: PrismaService) {}

  private async load(userId: string, projectId: string, manage: boolean) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId, status: 'active' } } },
      select: {
        id: true, name: true, status: true, ownerUserId: true,
        members: { where: { userId, status: 'active' }, select: { role: true } },
        stages: { where: { stageKey: 'build' }, select: { status: true, approvedVersionId: true } },
        publication: true,
        owner: { select: { email: true, externalIdentities: { where: { provider: 'telegram' }, select: { username: true } } } },
      },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    const role = project.members[0]?.role ?? 'viewer';
    if (manage && !manageRoles.has(role)) throw new ForbiddenException('PUBLICATION_FORBIDDEN');
    return { project, role };
  }

  private async acceptedBuild(project: { stages: Array<{ status: string; approvedVersionId: string | null }> }) {
    const stage = project.stages[0];
    if (!stage || stage.status !== 'approved' || !stage.approvedVersionId) return null;
    const version = await this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.approvedVersionId }, select: { id: true, versionNumber: true, content: true } });
    if (!version) return null;
    const site = version.content as unknown as SiteArtifact;
    return { versionId: version.id, versionNumber: version.versionNumber, hasForm: Boolean(site.meta?.hasForm), businessName: site.meta?.businessName ?? null };
  }

  async status(userId: string, projectId: string) {
    const { project, role } = await this.load(userId, projectId, false);
    const build = await this.acceptedBuild(project);
    const config = sitesConfig();
    const publication = project.publication;
    const publishedVersion = publication ? await this.prisma.stageArtifactVersion.findUnique({ where: { id: publication.buildVersionId }, select: { versionNumber: true } }) : null;
    const leads = await this.prisma.siteLead.count({ where: { projectId } });
    const telegram = telegramConfig();
    return {
      data: {
        publication: publication ? {
          slug: publication.slug, url: config.urlFor(publication.slug), status: publication.status, publishedAt: publication.publishedAt,
          unpublishedAt: publication.unpublishedAt, publishedVersionNumber: publishedVersion?.versionNumber ?? null,
          notifyTelegram: publication.notifyTelegram, notifyEmail: publication.notifyEmail,
        } : null,
        acceptedBuild: build ? { versionId: build.versionId, versionNumber: build.versionNumber, hasForm: build.hasForm } : null,
        outdated: Boolean(publication && publication.status === 'live' && build && build.versionId !== publication.buildVersionId),
        canManage: manageRoles.has(role) && project.status !== 'archived',
        suggestedSlug: publication?.slug ?? suggestSlug(build?.businessName ?? project.name),
        baseDomain: config.baseDomain,
        urlTemplate: config.urlTemplate,
        channels: {
          telegram: { configured: Boolean(telegram), linked: project.owner.externalIdentities.length > 0, username: project.owner.externalIdentities[0]?.username ?? null, botUsername: telegram?.botUsername ?? null },
          email: { configured: Boolean(emailConfig()), address: project.owner.email },
        },
        leadsCount: leads,
      },
    };
  }

  async checkSlug(userId: string, projectId: string, slug: string) {
    await this.load(userId, projectId, false);
    const problem = slugProblem(slug);
    if (problem) return { data: { slug, available: false, reason: problem, url: null } };
    const taken = await this.prisma.sitePublication.findFirst({ where: { slug, projectId: { not: projectId } }, select: { id: true } });
    return { data: { slug, available: !taken, reason: taken ? 'Этот адрес уже занят другим сайтом.' : null, url: sitesConfig().urlFor(slug) } };
  }

  async publish(userId: string, projectId: string, input: { slug: string; confirm: boolean }) {
    const { project } = await this.load(userId, projectId, true);
    if (!input.confirm) throw new BadRequestException('PUBLISH_CONFIRMATION_REQUIRED');
    if (!['active', 'live'].includes(project.status)) throw new ConflictException('PROJECT_NOT_ACTIVE');
    const build = await this.acceptedBuild(project);
    if (!build) throw new ConflictException('BUILD_NOT_ACCEPTED');
    const problem = slugProblem(input.slug);
    if (problem) throw new BadRequestException('INVALID_SLUG');
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const taken = await tx.sitePublication.findFirst({ where: { slug: input.slug, projectId: { not: projectId } }, select: { id: true } });
        if (taken) throw new ConflictException('SLUG_TAKEN');
        await tx.sitePublication.upsert({
          where: { projectId },
          create: { projectId, slug: input.slug, status: 'live', buildVersionId: build.versionId, publishedAt: now, publishedByUserId: userId },
          update: { slug: input.slug, status: 'live', buildVersionId: build.versionId, publishedAt: now, publishedByUserId: userId, unpublishedAt: null },
        });
        await tx.project.update({ where: { id: projectId }, data: { status: 'live' } });
        await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'site_published', stageKey: 'build', details: { slug: input.slug, buildVersion: build.versionNumber, previousSlug: project.publication?.slug ?? null } } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('SLUG_TAKEN');
      throw error;
    }
    return this.status(userId, projectId);
  }

  async unpublish(userId: string, projectId: string) {
    const { project } = await this.load(userId, projectId, true);
    if (!project.publication || project.publication.status !== 'live') throw new ConflictException('SITE_NOT_PUBLISHED');
    await this.prisma.$transaction(async (tx) => {
      await tx.sitePublication.update({ where: { projectId }, data: { status: 'unpublished', unpublishedAt: new Date() } });
      if (project.status === 'live') await tx.project.update({ where: { id: projectId }, data: { status: 'active' } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'site_unpublished', details: { slug: project.publication!.slug } } });
    });
    return this.status(userId, projectId);
  }

  async settings(userId: string, projectId: string, input: { notifyTelegram: boolean; notifyEmail: boolean }) {
    const { project } = await this.load(userId, projectId, true);
    if (!project.publication) throw new ConflictException('SITE_NOT_PUBLISHED');
    await this.prisma.sitePublication.update({ where: { projectId }, data: input });
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'lead_notifications_changed', details: input } });
    return this.status(userId, projectId);
  }

  async leads(userId: string, projectId: string, cursor: string | undefined, limit: number) {
    await this.load(userId, projectId, true);
    if (cursor && !isUuid(cursor)) throw new BadRequestException('INVALID_CURSOR');
    const rows = await this.prisma.siteLead.findMany({
      where: { projectId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, contact: true, message: true, createdAt: true, telegramStatus: true, emailStatus: true },
    });
    const data = rows.slice(0, limit);
    return { data, meta: { nextCursor: rows.length > limit ? data[data.length - 1]?.id ?? null : null } };
  }

  async deleteLead(userId: string, projectId: string, leadId: string) {
    await this.load(userId, projectId, true);
    if (!isUuid(leadId)) throw new NotFoundException('LEAD_NOT_FOUND');
    const deleted = await this.prisma.siteLead.deleteMany({ where: { id: leadId, projectId } });
    if (deleted.count !== 1) throw new NotFoundException('LEAD_NOT_FOUND');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'lead_deleted', details: { leadId } } });
  }
}
