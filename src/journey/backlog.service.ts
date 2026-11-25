import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { acceptRoles, isUuid, JourneyCore, writeRoles } from './journey-core.js';
import { reopenStage } from './stage-state.js';
import type { Suggestions } from './suggestions.js';
import type { AppFeatures } from './webapp.js';

export const BACKLOG_SOURCES = ['spec_later', 'suggestion', 'remark', 'feedback', 'owner'] as const;
export const BACKLOG_PRIORITIES = ['high', 'medium', 'low'] as const;
export const BACKLOG_STATUSES = ['open', 'next', 'done', 'dropped'] as const;
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * «Развитие» (PRODUCT_LIFECYCLE §4.12): one list of what comes next. It fills itself from what the project already decided
 * to postpone — ТЗ functions «позже», suggestions «потом», the owner's open remarks on scenarios — and takes people's
 * feedback and the owner's own ideas. Picking items for the next version reopens the ТЗ with them listed there; the stages
 * after the ТЗ get change notices as usual, so nothing else has to be gone through again unless it is affected.
 */
@Injectable()
export class BacklogService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  /** New postponed things from the accepted stages; an item already in the list is never overwritten. */
  private async gather(ctx: Awaited<ReturnType<JourneyCore['load']>>, projectId: string) {
    const content = async <T>(key: string) => {
      if (!ctx.route.includes(key as never)) return null;
      const stage = this.core.stageOf(ctx, key);
      return stage.approvedVersionId ? ((await this.core.versionContent(stage.approvedVersionId))?.content as T | undefined) ?? null : null;
    };
    const features = await content<AppFeatures>('features');
    const suggestions = await content<Suggestions>('suggestions');
    const remarks = await this.prisma.planTaskState.findMany({ where: { projectId, fromCaseKey: { not: null }, status: { notIn: ['done', 'done_with_note'] } }, select: { taskKey: true, title: true } });
    const found = [
      ...(features?.features ?? []).filter((item) => item.priority === 'later').map((item) => ({ source: 'spec_later', sourceKey: item.key, title: item.title, details: item.description, priority: 'medium' })),
      ...(suggestions?.items ?? []).filter((item) => item.decision === 'later').map((item) => ({ source: 'suggestion', sourceKey: item.key, title: item.title, details: item.value, priority: 'low' })),
      ...remarks.map((item) => ({ source: 'remark', sourceKey: item.taskKey, title: item.title ?? item.taskKey, details: null, priority: 'high' })),
    ];
    if (!found.length) return;
    await this.prisma.backlogItem.createMany({ data: found.map((item) => ({ projectId, ...item, title: item.title.slice(0, 200), details: item.details?.slice(0, 1000) ?? null })), skipDuplicates: true });
  }

  async list(userId: string, projectId: string) {
    const ctx = await this.core.load(userId, projectId, 'read');
    await this.gather(ctx, projectId);
    const items = await this.prisma.backlogItem.findMany({ where: { projectId }, orderBy: [{ createdAt: 'asc' }] });
    const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    const versions = items.map((item) => item.version ?? 1);
    const canEdit = ctx.viewer.kind === 'member' && writeRoles.has(ctx.role);
    const specStage = ctx.route.includes('features') ? this.core.stageOf(ctx, 'features') : null;
    return {
      data: {
        items: items.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1) || a.createdAt.getTime() - b.createdAt.getTime())
          .map((item) => ({ id: item.id, title: item.title, details: item.details, source: item.source, priority: item.priority, status: item.status, version: item.version, createdAt: item.createdAt })),
        // Version 1 is what the project launched with; a new one starts when items are taken in.
        currentVersion: Math.max(1, ...versions),
        canEdit, canStartVersion: canEdit && acceptRoles.has(ctx.role) && specStage?.status === 'approved',
        specStatus: specStage?.status ?? null,
      },
    };
  }

  async add(userId: string, projectId: string, input: { title?: unknown; details?: unknown; source?: unknown; priority?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'write');
    const title = clean(input.title, 200);
    if (title.length < 3) throw new BadRequestException('BACKLOG_TITLE_REQUIRED');
    const source = input.source === 'feedback' ? 'feedback' : 'owner';
    const priority = (BACKLOG_PRIORITIES as readonly unknown[]).includes(input.priority) ? input.priority as string : 'medium';
    const item = await this.prisma.backlogItem.create({ data: { projectId, title, details: clean(input.details, 1000) || null, source, priority, createdById: userId } });
    await this.core.event(this.prisma, projectId, userId, 'backlog_item_added', null, { itemId: item.id, source });
    return this.list(userId, ctx.project.id);
  }

  async update(userId: string, projectId: string, itemId: string, input: { title?: unknown; details?: unknown; priority?: unknown; status?: unknown }) {
    await this.core.load(userId, projectId, 'write');
    if (!isUuid(itemId)) throw new NotFoundException('BACKLOG_ITEM_NOT_FOUND');
    const item = await this.prisma.backlogItem.findFirst({ where: { id: itemId, projectId } });
    if (!item) throw new NotFoundException('BACKLOG_ITEM_NOT_FOUND');
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) { const title = clean(input.title, 200); if (title.length < 3) throw new BadRequestException('BACKLOG_TITLE_REQUIRED'); data.title = title; }
    if (input.details !== undefined) data.details = clean(input.details, 1000) || null;
    if (input.priority !== undefined) { if (!(BACKLOG_PRIORITIES as readonly unknown[]).includes(input.priority)) throw new BadRequestException('BACKLOG_PRIORITY_INVALID'); data.priority = input.priority; }
    if (input.status !== undefined) {
      if (!(BACKLOG_STATUSES as readonly unknown[]).includes(input.status) || input.status === 'next') throw new BadRequestException('BACKLOG_STATUS_INVALID');
      data.status = input.status;
      if (input.status === 'open') data.version = null;
    }
    await this.prisma.backlogItem.update({ where: { id: itemId }, data });
    return this.list(userId, projectId);
  }

  /**
   * «Следующая версия»: the chosen items get the next version number and the ТЗ is reopened; its page lists them, so
   * whoever edits the ТЗ sees what to take in. Its dependents (screens, architecture, plan, tests…) get change notices
   * when the new ТЗ is accepted, and only what changed has to be redone.
   */
  async startVersion(userId: string, projectId: string, input: { itemIds?: unknown }) {
    const ctx = await this.core.load(userId, projectId, 'accept', 'features');
    const ids = Array.isArray(input.itemIds) ? [...new Set(input.itemIds.filter((id): id is string => typeof id === 'string' && isUuid(id)))].slice(0, 50) : [];
    if (!ids.length) throw new BadRequestException('BACKLOG_NOTHING_CHOSEN');
    const items = await this.prisma.backlogItem.findMany({ where: { projectId, id: { in: ids }, status: 'open' } });
    if (items.length !== ids.length) throw new ConflictException('BACKLOG_ITEM_NOT_OPEN');
    const stage = this.core.stageOf(ctx, 'features');
    if (stage.status !== 'approved') throw new ConflictException('SPEC_NOT_ACCEPTED');
    const latest = await this.prisma.backlogItem.aggregate({ where: { projectId }, _max: { version: true } });
    const version = Math.max(1, latest._max.version ?? 1) + 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.backlogItem.updateMany({ where: { id: { in: ids } }, data: { status: 'next', version } });
      await this.core.writeStatuses(tx, ctx, reopenStage(ctx.statuses, 'features'));
      await this.core.event(tx, projectId, userId, 'version_started', 'features', { version, items: ids.length });
    });
    return this.list(userId, projectId);
  }
}
