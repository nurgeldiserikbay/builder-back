import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { tr } from '../i18n/i18n.js';
import { readPolicy } from '../team/team-rules.js';
import { lockableKeys } from './artifacts.js';
import { stageDefinitions, type StageKey } from './catalog.js';
import { acceptRoles, editableProject, isUuid, JourneyCore } from './journey-core.js';

export const COMMENT_LIMITS = { text: 2000, perStage: 300, files: 5, mentions: 10 };

/**
 * Remarks on a stage: on the whole result or one part (a block of texts, a field), pinned to the version they were
 * written about. A blocking remark (owner, managers or reviewers of the stage) stops acceptance and approval until it is
 * resolved. Observers read; everyone else who sees the stage may write. Nothing is deleted.
 */
@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  private async context(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const row = await this.prisma.projectStage.findUniqueOrThrow({ where: { id: stage.id }, select: { approvalPolicy: true } });
    const policy = readPolicy(row.approvalPolicy);
    const managing = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    const reviewer = ctx.viewer.kind === 'member' && Boolean(policy?.reviewers.includes(userId));
    const assignment = this.core.assignmentFor(ctx, key);
    const canWrite = ctx.viewer.kind === 'member' ? ctx.role !== 'viewer' : assignment?.status === 'active';
    return { ctx, stage, managing, reviewer, canWrite, canBlock: managing || reviewer, policy };
  }

  /** Who can be named in a remark: active members of the project and specialists working on this stage. Members only pick. */
  private async mentionable(ctx: { viewer: { kind: string } }, projectId: string, stageId: string, userId: string) {
    if (ctx.viewer.kind !== 'member') return [];
    const [members, specialists] = await Promise.all([
      this.prisma.projectMember.findMany({ where: { projectId, status: 'active', userId: { not: userId } }, select: { userId: true, user: { select: { name: true, email: true } } } }),
      this.prisma.stageAssignment.findMany({ where: { stageId, status: 'active', userId: { not: null } }, select: { userId: true, email: true, user: { select: { name: true } } } }),
    ]);
    const people = new Map<string, string>();
    for (const row of members) people.set(row.userId, row.user.name || row.user.email.split('@')[0]!);
    for (const row of specialists) if (row.userId && row.userId !== userId && !people.has(row.userId)) people.set(row.userId, row.user?.name || row.email.split('@')[0]!);
    return [...people].map(([id, name]) => ({ id, name }));
  }

  async list(userId: string, projectId: string, key: string) {
    const { ctx, stage, managing, canWrite, canBlock } = await this.context(userId, projectId, key);
    const rows = await this.prisma.stageComment.findMany({ where: { stageId: stage.id }, orderBy: { createdAt: 'asc' }, take: COMMENT_LIMITS.perStage });
    const fileIds = [...new Set(rows.flatMap((row) => row.fileIds))];
    const [files, stageFiles, mentionable] = await Promise.all([
      fileIds.length ? this.prisma.stageFile.findMany({ where: { id: { in: fileIds }, stageId: stage.id }, select: { id: true, name: true, kind: true, sizeBytes: true } }) : Promise.resolve([]),
      canWrite ? this.prisma.stageFile.findMany({ where: { stageId: stage.id }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, kind: true, sizeBytes: true } }) : Promise.resolve([]),
      canWrite ? this.mentionable(ctx, projectId, stage.id, userId) : Promise.resolve([]),
    ]);
    const fileById = new Map(files.map((file) => [file.id, file]));
    const attachments = (ids: string[]) => ids.map((id) => fileById.get(id) ?? { id, name: null, kind: null, sizeBytes: null, deleted: true });
    const people = await this.core.historyPeople(ctx, projectId, userId);
    const name = (id: string | null) => (id ? people.get(id)?.name ?? tr('Участник') : null);
    const current = await this.core.versionContent(stage.currentVersionId);
    const thread = (parentId: string | null) => rows.filter((row) => row.parentId === parentId);
    const view = (row: (typeof rows)[number]) => ({
      id: row.id, text: row.text, attachments: attachments(row.fileIds), mentions: row.mentionUserIds.map((id) => name(id) ?? tr('Участник')), targetKey: row.targetKey, versionNumber: row.versionNumber, blocking: row.blocking, author: name(row.authorUserId), mine: row.authorUserId === userId,
      createdAt: row.createdAt, resolved: Boolean(row.resolvedAt), resolvedAt: row.resolvedAt, resolvedBy: name(row.resolvedByUserId),
      canResolve: !row.parentId && (managing || row.authorUserId === userId),
      replies: thread(row.id).map((reply) => ({ id: reply.id, text: reply.text, author: name(reply.authorUserId), mine: reply.authorUserId === userId, createdAt: reply.createdAt, attachments: attachments(reply.fileIds), mentions: reply.mentionUserIds.map((id) => name(id) ?? tr('Участник')) })),
    });
    const top = thread(null).map(view);
    return {
      data: {
        comments: top, openBlocking: top.filter((item) => item.blocking && !item.resolved).length, open: top.filter((item) => !item.resolved).length,
        canWrite, canBlock, canUpload: canWrite && this.core.canWrite(ctx, key) && editableProject(ctx.project.status), currentVersion: current?.versionNumber ?? null, files: stageFiles, people: mentionable, limits: { files: COMMENT_LIMITS.files, mentions: COMMENT_LIMITS.mentions },
        targets: current ? lockableKeys(stageDefinitions[key as StageKey].artifactType, current.content) : [],
      },
    };
  }

  async add(userId: string, projectId: string, key: string, input: { text: string; targetKey: string | null; blocking: boolean; parentId: string | null; fileIds?: string[]; mentionUserIds?: string[] }) {
    const { ctx, stage, canWrite, canBlock, policy } = await this.context(userId, projectId, key);
    if (!canWrite) throw new ForbiddenException('COMMENT_FORBIDDEN');
    const text = input.text.replace(/\u0000/g, '').trim();
    if (text.length < 2 || text.length > COMMENT_LIMITS.text) throw new BadRequestException('COMMENT_TEXT_INVALID');
    if (await this.prisma.stageComment.count({ where: { stageId: stage.id } }) >= COMMENT_LIMITS.perStage) throw new ConflictException('COMMENT_LIMIT_REACHED');
    let parent: { id: string; authorUserId: string } | null = null;
    if (input.parentId) {
      if (!isUuid(input.parentId)) throw new NotFoundException('COMMENT_NOT_FOUND');
      parent = await this.prisma.stageComment.findFirst({ where: { id: input.parentId, stageId: stage.id, parentId: null }, select: { id: true, authorUserId: true } });
      if (!parent) throw new NotFoundException('COMMENT_NOT_FOUND');
    }
    if (input.blocking && (!canBlock || parent)) throw new ForbiddenException('COMMENT_BLOCKING_FORBIDDEN');
    const fileIds = [...new Set(input.fileIds ?? [])];
    const mentionIds = [...new Set(input.mentionUserIds ?? [])].filter((id) => id !== userId);
    if (fileIds.length > COMMENT_LIMITS.files || fileIds.some((id) => !isUuid(id))) throw new BadRequestException('COMMENT_FILES_INVALID');
    if (mentionIds.length > COMMENT_LIMITS.mentions || mentionIds.some((id) => !isUuid(id))) throw new BadRequestException('COMMENT_MENTIONS_INVALID');
    if (fileIds.length && (await this.prisma.stageFile.count({ where: { id: { in: fileIds }, stageId: stage.id } })) !== fileIds.length) throw new NotFoundException('FILE_NOT_FOUND');
    if (mentionIds.length) {
      const allowed = new Set((await this.mentionable(ctx, projectId, stage.id, userId)).map((person) => person.id));
      if (mentionIds.some((id) => !allowed.has(id))) throw new BadRequestException('COMMENT_MENTIONS_INVALID');
    }
    const current = await this.core.versionContent(stage.currentVersionId);
    if (input.targetKey && (!current || !lockableKeys(stageDefinitions[key as StageKey].artifactType, current.content).includes(input.targetKey))) throw new NotFoundException('TARGET_NOT_FOUND');
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.stageComment.create({ data: { projectId, stageId: stage.id, parentId: parent?.id ?? null, versionNumber: current?.versionNumber ?? null, targetKey: parent ? null : input.targetKey, authorUserId: userId, text, blocking: input.blocking, fileIds, mentionUserIds: mentionIds } });
      await this.core.event(tx, projectId, userId, parent ? 'stage_comment_replied' : 'stage_comment_added', key, { commentId: row.id, blocking: input.blocking, files: fileIds.length, mentions: mentionIds.length });
      return row;
    });
    // People on the stage hear about it: the owner, the lead, the author of the version, reviewers; a reply goes to the thread author.
    const recipients = new Set<string>();
    if (parent) recipients.add(parent.authorUserId);
    else {
      recipients.add(ctx.project.ownerUserId);
      const leads = await this.prisma.stageAssignment.findMany({ where: { stageId: stage.id, status: 'active' }, select: { userId: true } });
      for (const lead of leads) if (lead.userId) recipients.add(lead.userId);
      if (stage.currentVersionId) {
        const author = await this.prisma.stageArtifactVersion.findUnique({ where: { id: stage.currentVersionId }, select: { createdByUserId: true } });
        if (author) recipients.add(author.createdByUserId);
      }
      for (const id of policy?.reviewers ?? []) recipients.add(id);
    }
    recipients.delete(userId);
    for (const id of mentionIds) recipients.delete(id);
    const title = stageDefinitions[key as StageKey].title;
    for (const id of mentionIds) {
      await this.core.notifyUser(id, () => tr('Вас упомянули в замечании к этапу «{0}» в проекте «{1}»: {2} {3}', [tr(title), ctx.project.name, text.slice(0, 300), this.core.stageLink(projectId, key)]).trim()).catch(() => undefined);
    }
    for (const id of recipients) {
      await this.core.notifyUser(id, () => tr(input.blocking ? 'Блокирующее замечание к этапу «{0}» в проекте «{1}»: {2} {3}' : 'Новое замечание к этапу «{0}» в проекте «{1}»: {2} {3}', [tr(title), ctx.project.name, text.slice(0, 300), this.core.stageLink(projectId, key)]).trim()).catch(() => undefined);
    }
    const listed = await this.list(userId, projectId, key);
    return { data: { ...listed.data, createdId: created.id } };
  }

  async resolve(userId: string, projectId: string, key: string, commentId: string, resolved: boolean) {
    const { stage, managing } = await this.context(userId, projectId, key);
    if (!isUuid(commentId)) throw new NotFoundException('COMMENT_NOT_FOUND');
    const row = await this.prisma.stageComment.findFirst({ where: { id: commentId, stageId: stage.id, parentId: null }, select: { id: true, authorUserId: true, resolvedAt: true } });
    if (!row) throw new NotFoundException('COMMENT_NOT_FOUND');
    if (!managing && row.authorUserId !== userId) throw new ForbiddenException('COMMENT_RESOLVE_FORBIDDEN');
    if (Boolean(row.resolvedAt) !== resolved) {
      await this.prisma.$transaction(async (tx) => {
        await tx.stageComment.update({ where: { id: row.id }, data: resolved ? { resolvedAt: new Date(), resolvedByUserId: userId } : { resolvedAt: null, resolvedByUserId: null } });
        await this.core.event(tx, projectId, userId, resolved ? 'stage_comment_resolved' : 'stage_comment_reopened', key, { commentId: row.id });
      });
    }
    return this.list(userId, projectId, key);
  }

  /** Blocking remarks still open on the stage; acceptance and approval check this. */
  static async openBlocking(prisma: Pick<PrismaService, 'stageComment'>, stageId: string): Promise<number> {
    return prisma.stageComment.count({ where: { stageId, parentId: null, blocking: true, resolvedAt: null } });
  }
}
