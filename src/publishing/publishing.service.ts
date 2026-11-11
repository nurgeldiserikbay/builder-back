import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { SiteArtifact } from '../journey/artifacts.js';
import { emailConfig } from '../notifications/email.js';
import { telegramConfig } from '../notifications/telegram.js';
import { sitesConfig, slugProblem, suggestSlug } from './slug.js';
import { BillingService } from '../billing/billing.service.js';
import { Resolver } from 'node:dns/promises';
import { domainToUnicode } from 'node:url';
import { domainProblem, domainTarget, isApex, isKzZone, normalizeDomain, pointsHere, recordsFor } from './domain.js';

/** Resolvers for the DNS check; SITES_DNS_SERVERS lets operators use public resolvers instead of the host's cache. */
function dnsResolver() {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  const servers = (process.env.SITES_DNS_SERVERS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (servers.length) resolver.setServers(servers);
  return resolver;
}

const manageRoles = new Set(['owner', 'manager']);

function domainToUnicodeSafe(name: string): string {
  try { return domainToUnicode(name) || name; } catch { return name; }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Injectable()
export class PublishingService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService) {}

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
          domain: this.domainView(publication),
        } : null,
        domainsAvailable: Boolean(domainTarget()),
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
    await this.billing.assertCanPublish(projectId);
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

  private domainView(publication: { customDomain: string | null; domainStatus: string | null; domainCheckedAt: Date | null; domainError: string | null }) {
    const target = domainTarget();
    if (!publication.customDomain) return null;
    const name = publication.customDomain;
    return {
      name, display: domainToUnicodeSafe(name), status: publication.domainStatus, checkedAt: publication.domainCheckedAt, error: publication.domainError,
      apex: isApex(name), url: publication.domainStatus === 'active' ? `https://${name}` : null,
      records: target ? recordsFor(name, target) : [],
    };
  }

  /** Saves the owner's domain as pending and returns the DNS record to create; nothing is served on it until the check passes. */
  async setDomain(userId: string, projectId: string, raw: string) {
    const { project } = await this.load(userId, projectId, true);
    if (!project.publication) throw new ConflictException('SITE_NOT_PUBLISHED');
    const target = domainTarget();
    if (!target) throw new ConflictException('DOMAINS_NOT_CONFIGURED');
    const domain = normalizeDomain(raw);
    const problem = domainProblem(domain, sitesConfig().baseDomain, target);
    if (problem) throw new BadRequestException(problem);
    if (isApex(domain!) && !target.ipv4.length) throw new BadRequestException('DOMAIN_APEX_UNSUPPORTED');
    if (project.publication.customDomain === domain) return this.status(userId, projectId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.sitePublication.update({ where: { projectId }, data: { customDomain: domain, domainStatus: 'pending', domainCheckedAt: null, domainError: null } });
        await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'domain_set', details: { domain, previous: project.publication!.customDomain } } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException('DOMAIN_TAKEN');
      throw error;
    }
    return this.status(userId, projectId);
  }

  /** Looks the domain up in DNS; it becomes active only when it points at BuildPath. */
  async checkDomain(userId: string, projectId: string, resolver = dnsResolver()) {
    const { project } = await this.load(userId, projectId, true);
    const publication = project.publication;
    if (!publication?.customDomain) throw new ConflictException('DOMAIN_NOT_SET');
    const target = domainTarget();
    if (!target) throw new ConflictException('DOMAINS_NOT_CONFIGURED');
    if (isKzZone(publication.customDomain) && !target.hostedInKz) throw new BadRequestException('DOMAIN_KZ_NEEDS_KZ_HOSTING');
    if (publication.domainCheckedAt && Date.now() - publication.domainCheckedAt.getTime() < 10_000) throw new ConflictException('DOMAIN_CHECK_TOO_SOON');
    const result = await pointsHere(publication.customDomain, target, resolver);
    const status = result.ok ? 'active' : (publication.domainStatus === 'active' ? 'failed' : 'pending');
    const error = result.ok ? null : result.found.length ? 'DNS_POINTS_ELSEWHERE' : 'DNS_RECORD_NOT_FOUND';
    await this.prisma.$transaction(async (tx) => {
      await tx.sitePublication.update({ where: { projectId }, data: { domainStatus: status, domainCheckedAt: new Date(), domainError: error } });
      if (status !== publication.domainStatus) {
        await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'domain_checked', details: { domain: publication.customDomain, status, error } } });
      }
    });
    const view = await this.status(userId, projectId);
    return { data: { ...view.data, domainCheck: { ok: result.ok, found: result.found.slice(0, 5) } } };
  }

  async removeDomain(userId: string, projectId: string) {
    const { project } = await this.load(userId, projectId, true);
    const publication = project.publication;
    if (!publication?.customDomain) throw new ConflictException('DOMAIN_NOT_SET');
    await this.prisma.$transaction(async (tx) => {
      await tx.sitePublication.update({ where: { projectId }, data: { customDomain: null, domainStatus: null, domainCheckedAt: null, domainError: null } });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'domain_removed', details: { domain: publication.customDomain } } });
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

  /** Client bookings of the published site: upcoming (from today, by time) or past (newest first). */
  async bookings(userId: string, projectId: string, scope: 'upcoming' | 'past') {
    const { project } = await this.load(userId, projectId, true);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 12 * 3_600_000);
    const rows = await this.prisma.booking.findMany({
      where: { projectId, ...(scope === 'upcoming' ? { endsAt: { gte: dayAgo } } : { endsAt: { lt: dayAgo } }) },
      orderBy: { startsAt: scope === 'upcoming' ? 'asc' : 'desc' }, take: 200,
      select: { id: true, serviceName: true, minutes: true, price: true, masterName: true, startsAt: true, endsAt: true, timezone: true, clientName: true, clientPhone: true, comment: true, status: true, telegramStatus: true, reminderStatus: true, reminderAt: true, cancelledAt: true, createdAt: true },
    });
    const live = project.publication?.status === 'live';
    return { data: { bookings: rows, live, siteName: project.name, emailReminders: Boolean(emailConfig()) && process.env.BOOKING_EMAIL_REMINDERS !== 'off', siteUrl: live && project.publication ? sitesConfig().urlFor(project.publication.slug) : null } };
  }

  /** A cancelled booking needs no reminder: the client's address is erased right away. */
  private dropReminder(reminderStatus: string | null) {
    return reminderStatus === 'pending' ? { reminderStatus: 'skipped', clientEmail: null, cancelLinkSealed: null } : {};
  }

  /** Owner marks a booking: cancel it (the time becomes free again), or after the visit — came or did not come. */
  async setBookingStatus(userId: string, projectId: string, bookingId: string, status: 'cancelled_by_owner' | 'done' | 'no_show') {
    await this.load(userId, projectId, true);
    if (!isUuid(bookingId)) throw new NotFoundException('BOOKING_NOT_FOUND');
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, projectId }, select: { id: true, status: true, startsAt: true, reminderStatus: true } });
    if (!booking) throw new NotFoundException('BOOKING_NOT_FOUND');
    const allowed = status === 'cancelled_by_owner' ? booking.status === 'booked' : ['booked', 'done', 'no_show'].includes(booking.status) && booking.startsAt <= new Date();
    if (!allowed) throw new ConflictException(status === 'cancelled_by_owner' ? 'BOOKING_NOT_ACTIVE' : 'BOOKING_NOT_STARTED');
    await this.prisma.$transaction([
      this.prisma.booking.update({ where: { id: booking.id }, data: { status, ...(status === 'cancelled_by_owner' ? { cancelledAt: new Date(), ...this.dropReminder(booking.reminderStatus) } : {}) } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'booking_status_changed', details: { bookingId, status } } }),
    ]);
    return this.bookings(userId, projectId, booking.startsAt.getTime() > Date.now() - 12 * 3_600_000 ? 'upcoming' : 'past');
  }
}
