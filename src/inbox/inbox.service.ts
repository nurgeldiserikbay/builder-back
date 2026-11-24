import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyCore } from '../journey/journey-core.js';
import { AUTO_APPROVE_MS } from '../journey/worktime.js';
import { activityKinds, canSee, displayName, kindOf, orderInbox, publicDetails, quote, type ActivityKind, type ActivityViewer, type InboxItem } from './inbox-rules.js';

const OPEN_PROJECT = ['active', 'live', 'paused'] as const;
const MANAGERS = ['owner', 'manager'] as const;
const UPDATES_DAYS = 14;
const MENTION_DAYS = 30;

type ProjectRef = { id: string; name: string; projectType: string | null };

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  /**
   * Everything that waits for this person across their projects, computed from the current state (inbox-rules.ts),
   * and the recent updates by other people with the count of those not seen yet.
   */
  async inbox(userId: string) {
    const [memberships, assignments, user] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId, status: 'active', project: { status: { in: [...OPEN_PROJECT] }, projectType: { not: null } } },
        select: { role: true, stageKeys: true, project: { select: { id: true, name: true, projectType: true, ownerUserId: true } } },
      }),
      this.prisma.stageAssignment.findMany({
        where: { userId, status: 'active', project: { status: { in: [...OPEN_PROJECT] } } },
        select: { id: true, role: true, stageId: true, stage: { select: { stageKey: true } }, project: { select: { id: true, name: true, projectType: true } } },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { inboxSeenAt: true } }),
    ]);
    const projects = new Map<string, ProjectRef>();
    for (const row of memberships) projects.set(row.project.id, row.project);
    for (const row of assignments) projects.set(row.project.id, row.project);
    const managed = memberships.filter((row) => (MANAGERS as readonly string[]).includes(row.role)).map((row) => row.project.id);
    const owned = memberships.filter((row) => row.project.ownerUserId === userId).map((row) => row.project.id);
    const leadStageIds = assignments.filter((row) => row.role === 'lead').map((row) => row.stageId);
    const ref = (projectId: string) => projects.get(projectId)!;
    const items: InboxItem[] = [];
    const push = (item: Omit<InboxItem, 'projectName' | 'projectType' | 'dueAt' | 'count' | 'who' | 'text'> & Partial<InboxItem>) => {
      const project = ref(item.projectId);
      items.push({ dueAt: null, count: 1, who: null, text: null, ...item, projectName: project.name, projectType: project.projectType });
    };

    const [reviews, returned, notices, proposals, hours, disputes, mentions, requests] = await Promise.all([
      // Stages waiting for acceptance, unless this person already gave their approval for the current version.
      managed.length ? this.prisma.projectStage.findMany({
        where: { projectId: { in: managed }, status: 'in_review' },
        select: { id: true, projectId: true, stageKey: true, currentVersionId: true, updatedAt: true, approvals: { where: { userId }, select: { versionId: true } } },
      }) : [],
      // Returned stages: for the lead specialist; for the owner when nobody leads the stage.
      this.prisma.projectStage.findMany({
        where: {
          status: 'changes_requested',
          OR: [
            ...(leadStageIds.length ? [{ id: { in: leadStageIds } }] : []),
            ...(owned.length ? [{ projectId: { in: owned }, assignments: { none: { role: 'lead' as const, status: 'active' as const } } }] : []),
          ],
        },
        select: { projectId: true, stageKey: true, updatedAt: true, reviewNote: true },
      }).catch(() => []),
      // Change notices are answered by the target stage: its lead, or the owner and managers when nobody leads it.
      this.prisma.changeNotice.findMany({
        where: {
          status: { in: ['open', 'discussing'] },
          OR: [
            ...(leadStageIds.length ? [{ targetStageId: { in: leadStageIds } }] : []),
            ...(managed.length ? [{ projectId: { in: managed }, targetStage: { assignments: { none: { role: 'lead' as const, status: 'active' as const } } } }] : []),
          ],
        },
        select: { id: true, projectId: true, createdAt: true, respondBy: true, targetStage: { select: { stageKey: true } }, sourceStage: { select: { stageKey: true } } },
      }).catch(() => []),
      managed.length ? this.prisma.changeProposal.findMany({
        where: { projectId: { in: managed }, status: 'open' },
        select: { id: true, projectId: true, createdAt: true, text: true, targetStage: { select: { stageKey: true } }, author: { select: { name: true } } },
      }) : [],
      managed.length ? this.prisma.timeEntry.findMany({
        // Undisputed hours count as approved after three days, so only younger ones wait for a decision.
        where: { projectId: { in: managed }, status: 'pending', createdAt: { gt: new Date(Date.now() - AUTO_APPROVE_MS) } },
        select: { assignmentId: true, projectId: true, createdAt: true, assignment: { select: { stage: { select: { stageKey: true } }, user: { select: { name: true } } } } },
      }) : [],
      this.prisma.dispute.findMany({
        where: {
          status: 'open',
          OR: [
            ...(managed.length ? [{ projectId: { in: managed }, openedBySide: 'specialist' }] : []),
            { openedBySide: 'owner', assignment: { userId } },
          ],
        },
        select: { id: true, projectId: true, createdAt: true, claim: true, assignment: { select: { stage: { select: { stageKey: true } } } } },
      }),
      projects.size ? this.prisma.stageComment.findMany({
        where: { projectId: { in: [...projects.keys()] }, mentionUserIds: { has: userId }, resolvedAt: null, authorUserId: { not: userId }, createdAt: { gte: new Date(Date.now() - MENTION_DAYS * 86_400_000) } },
        select: { id: true, projectId: true, createdAt: true, text: true, stage: { select: { stageKey: true } } },
        orderBy: { createdAt: 'desc' }, take: 50,
      }) : [],
      // Stage requests with responses to look at: open, not past their closing time.
      managed.length ? this.prisma.stageRequest.findMany({
        where: { projectId: { in: managed }, status: 'open', closesAt: { gt: new Date() }, responses: { some: { status: 'sent' } } },
        select: { id: true, projectId: true, closesAt: true, stage: { select: { stageKey: true } }, responses: { where: { status: 'sent' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } } },
      }) : [],
    ]);

    for (const stage of reviews) {
      if (stage.currentVersionId && stage.approvals.some((approval) => approval.versionId === stage.currentVersionId)) continue;
      push({ id: `review:${stage.id}:${stage.currentVersionId ?? ''}`, kind: 'stage_review', projectId: stage.projectId, stageKey: stage.stageKey, since: stage.updatedAt.toISOString() });
    }
    for (const stage of returned) {
      push({ id: `changes:${stage.projectId}:${stage.stageKey}`, kind: 'stage_changes', projectId: stage.projectId, stageKey: stage.stageKey, since: stage.updatedAt.toISOString(), text: quote(stage.reviewNote) });
    }
    for (const notice of notices) {
      push({ id: `notice:${notice.id}`, kind: 'change_notice', projectId: notice.projectId, stageKey: notice.targetStage.stageKey, since: notice.createdAt.toISOString(), dueAt: notice.respondBy?.toISOString() ?? null, text: notice.sourceStage.stageKey });
    }
    for (const proposal of proposals) {
      push({ id: `proposal:${proposal.id}`, kind: 'change_proposal', projectId: proposal.projectId, stageKey: proposal.targetStage.stageKey, since: proposal.createdAt.toISOString(), who: displayName(proposal.author), text: quote(proposal.text) });
    }
    type HourRow = { assignmentId: string; projectId: string; createdAt: Date; assignment: { stage: { stageKey: string }; user: { name: string | null } | null } };
    const byAssignment = new Map<string, HourRow[]>();
    for (const entry of hours as HourRow[]) byAssignment.set(entry.assignmentId, [...(byAssignment.get(entry.assignmentId) ?? []), entry]);
    for (const [assignmentId, entries] of byAssignment) {
      const first = entries.reduce((oldest, entry) => (entry.createdAt < oldest.createdAt ? entry : oldest));
      push({ id: `time:${assignmentId}`, kind: 'time_entries', projectId: first.projectId, stageKey: first.assignment.stage.stageKey, since: first.createdAt.toISOString(), dueAt: new Date(first.createdAt.getTime() + AUTO_APPROVE_MS).toISOString(), count: entries.length, who: displayName(first.assignment.user) });
    }
    for (const dispute of disputes) {
      if (!projects.has(dispute.projectId)) continue;
      push({ id: `dispute:${dispute.id}`, kind: 'dispute', projectId: dispute.projectId, stageKey: dispute.assignment.stage.stageKey, since: dispute.createdAt.toISOString(), text: quote(dispute.claim) });
    }
    for (const comment of mentions) {
      push({ id: `mention:${comment.id}`, kind: 'mention', projectId: comment.projectId, stageKey: comment.stage.stageKey, since: comment.createdAt.toISOString(), text: quote(comment.text) });
    }

    for (const request of requests) {
      push({ id: `request:${request.id}`, kind: 'request_responses', projectId: request.projectId, stageKey: request.stage.stageKey, since: request.responses[0]!.createdAt.toISOString(), dueAt: request.closesAt.toISOString(), count: request.responses.length });
    }

    const updates = await this.updates(userId, memberships, assignments);
    const seenAt = user?.inboxSeenAt ?? null;
    return {
      data: {
        waiting: orderInbox(items),
        updates: updates.map((event) => ({ ...event, unread: !seenAt || new Date(event.createdAt) > seenAt })),
        unreadUpdates: updates.filter((event) => !seenAt || new Date(event.createdAt) > seenAt).length,
        seenAt: seenAt?.toISOString() ?? null,
      },
    };
  }

  /** Marks the updates feed as seen. */
  async markSeen(userId: string) {
    const now = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { inboxSeenAt: now } });
    return { data: { seenAt: now.toISOString() } };
  }

  /** What other people did in this person's projects in the last two weeks, with the same access rules as the log. */
  private async updates(
    userId: string,
    memberships: Array<{ role: string; stageKeys: string[]; project: ProjectRef }>,
    assignments: Array<{ stage: { stageKey: string }; project: ProjectRef }>,
  ) {
    const viewers = new Map<string, ActivityViewer>();
    for (const row of memberships) viewers.set(row.project.id, { kind: 'member', role: row.role, stageKeys: row.role === 'contributor' ? row.stageKeys : [] });
    for (const row of assignments) {
      const current = viewers.get(row.project.id);
      if (current?.kind === 'member') continue;
      viewers.set(row.project.id, { kind: 'specialist', stageKeys: [...(current?.kind === 'specialist' ? current.stageKeys : []), row.stage.stageKey] });
    }
    if (viewers.size === 0) return [];
    const names = new Map([...memberships.map((row) => row.project), ...assignments.map((row) => row.project)].map((project) => [project.id, project]));
    const rows = await this.prisma.projectEvent.findMany({
      where: { projectId: { in: [...viewers.keys()] }, createdAt: { gte: new Date(Date.now() - UPDATES_DAYS * 86_400_000) }, NOT: { actorUserId: userId } },
      orderBy: { createdAt: 'desc' }, take: 300,
      select: { id: true, projectId: true, type: true, stageKey: true, details: true, createdAt: true, actorUserId: true },
    });
    const visible = rows.filter((row) => canSee(viewers.get(row.projectId)!, row)).slice(0, 60);
    const actors = await this.actors(visible.map((row) => row.actorUserId));
    return visible.map((row) => ({
      id: row.id, projectId: row.projectId, projectName: names.get(row.projectId)?.name ?? '', projectType: names.get(row.projectId)?.projectType ?? null,
      type: row.type, kind: kindOf(row.type), stageKey: row.stageKey, createdAt: row.createdAt.toISOString(), details: publicDetails(row.details),
      actor: row.actorUserId ? { id: row.actorUserId, name: actors.get(row.actorUserId) ?? null, isMe: false } : null,
    }));
  }

  /** The project's activity log, newest first, with the viewer's access applied (inbox-rules.ts, canSee). */
  async activity(userId: string, projectId: string, query: { cursor?: string; kind?: string; stageKey?: string; limit?: string }) {
    const ctx = await this.core.load(userId, projectId, 'read');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('INVALID_LIMIT');
    if (query.kind !== undefined && !activityKinds.includes(query.kind as ActivityKind)) throw new BadRequestException('INVALID_KIND');
    if (query.stageKey !== undefined && !ctx.route.includes(query.stageKey as never)) throw new BadRequestException('INVALID_STAGE');
    let before: Date | null = null;
    if (query.cursor !== undefined) {
      before = new Date(query.cursor);
      if (Number.isNaN(before.getTime())) throw new BadRequestException('INVALID_CURSOR');
    }
    const viewer: ActivityViewer = ctx.viewer.kind === 'member'
      ? { kind: 'member', role: ctx.viewer.role, stageKeys: ctx.viewer.stageKeys }
      : { kind: 'specialist', stageKeys: ctx.viewer.assignments.map((item) => item.stageKey) };
    // Read in pages and filter in memory: access rules depend on the event type, and the log is small per project.
    const out: Array<{ id: string; type: string; stageKey: string | null; details: unknown; createdAt: Date; actorUserId: string | null }> = [];
    let cursor = before;
    for (let page = 0; page < 6 && out.length <= limit; page += 1) {
      const rows = await this.prisma.projectEvent.findMany({
        where: { projectId, ...(cursor ? { createdAt: { lt: cursor } } : {}), ...(query.stageKey ? { stageKey: query.stageKey } : {}) },
        orderBy: { createdAt: 'desc' }, take: 200,
        select: { id: true, type: true, stageKey: true, details: true, createdAt: true, actorUserId: true },
      });
      for (const row of rows) if (canSee(viewer, row) && (!query.kind || kindOf(row.type) === query.kind)) out.push(row);
      if (rows.length < 200) { cursor = null; break; }
      cursor = rows[rows.length - 1]!.createdAt;
    }
    const pageRows = out.slice(0, limit);
    const hasMore = out.length > limit || cursor !== null;
    const actors = await this.actors(pageRows.map((row) => row.actorUserId));
    return {
      data: pageRows.map((row) => ({
        id: row.id, type: row.type, kind: kindOf(row.type), stageKey: row.stageKey, createdAt: row.createdAt.toISOString(), details: publicDetails(row.details),
        actor: row.actorUserId ? { id: row.actorUserId, name: actors.get(row.actorUserId) ?? null, isMe: row.actorUserId === userId } : null,
      })),
      meta: { nextCursor: hasMore && pageRows.length ? pageRows[pageRows.length - 1]!.createdAt.toISOString() : null },
    };
  }

  private async actors(ids: Array<string | null>): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((user) => [user.id, displayName(user)]));
  }
}
