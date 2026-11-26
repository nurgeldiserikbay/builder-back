import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { stageDefinitions, type StageKey, definitionOf } from './catalog.js';
import { JourneyCore, acceptRoles, editableProject, isUuid } from './journey-core.js';
import { briefFromStory, type Brief, type Story } from './artifacts.js';
import { PLAYBOOK_LIMITS, checkPlaybook, parsePlaybook, projectFingerprints, type PlaybookIssue } from './playbooks.js';

const playbookSelect = { id: true, stageKey: true, title: true, instructions: true, checklist: true, version: true, checkIssues: true, updatedAt: true } as const;
type PlaybookRow = { id: string; stageKey: string; title: string; instructions: string[]; checklist: string[]; version: number; checkIssues: unknown; updatedAt: Date };
const view = (row: PlaybookRow) => ({
  id: row.id, stageKey: row.stageKey, stageTitle: definitionOf(row.stageKey as StageKey)?.title ?? row.stageKey, title: row.title,
  instructions: row.instructions, checklist: row.checklist, version: row.version, issues: row.checkIssues as PlaybookIssue[], updatedAt: row.updatedAt,
});

/** Personal playbooks (STAGE_WORK_MODEL §7.4): the specialist keeps them; a stage lead attaches one; the owner sees and can detach it. */
@Injectable()
export class PlaybooksService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  async mine(userId: string) {
    const rows = await this.prisma.specialistPlaybook.findMany({ where: { ownerUserId: userId }, orderBy: { updatedAt: 'desc' }, select: playbookSelect });
    return { data: { playbooks: rows.map(view), limits: PLAYBOOK_LIMITS, stages: Object.values(stageDefinitions).filter((item) => item.ai.level !== 'none').map((item) => ({ key: item.key, title: item.title })) } };
  }

  async create(userId: string, raw: unknown) {
    const content = parsePlaybook(raw);
    if (await this.prisma.specialistPlaybook.count({ where: { ownerUserId: userId } }) >= PLAYBOOK_LIMITS.perUser) throw new ConflictException('PLAYBOOK_LIMIT');
    const row = await this.prisma.specialistPlaybook.create({ data: { ownerUserId: userId, ...content, checkIssues: checkPlaybook(content) as never }, select: playbookSelect });
    return { data: view(row) };
  }

  /** Each change is a new version; stages keep the version they attached until the lead attaches again. */
  async update(userId: string, id: string, raw: unknown) {
    const own = await this.own(userId, id);
    const content = parsePlaybook(raw);
    const row = await this.prisma.specialistPlaybook.update({ where: { id: own.id }, data: { ...content, version: { increment: 1 }, checkIssues: checkPlaybook(content) as never }, select: playbookSelect });
    return { data: view(row) };
  }

  async remove(userId: string, id: string) {
    const own = await this.own(userId, id);
    // Attached copies stay on the stages (the owner saw them); they only lose the link to the original.
    await this.prisma.specialistPlaybook.delete({ where: { id: own.id } });
    return { data: { id: own.id, deleted: true } };
  }

  /** What is attached to a stage, and — for its active lead — which own playbooks could be attached and whether they pass here. */
  async stage(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const attached = await this.prisma.stagePlaybook.findUnique({ where: { stageId: stage.id }, select: { id: true, playbookId: true, title: true, version: true, instructions: true, checklist: true, attachedByUserId: true, attachedAt: true, playbook: { select: { version: true } } } });
    const assignment = this.core.assignmentFor(ctx, key);
    const lead = assignment?.role === 'lead' && assignment.status === 'active';
    const people = attached ? await this.core.historyPeople(ctx, projectId, userId) : null;
    const active = attached ? Boolean(await this.core.activePlaybook(stage.id)) : false;
    let mine: Array<ReturnType<typeof view> & { issuesHere: PlaybookIssue[] }> = [];
    if (lead) {
      const fingerprints = await this.fingerprints(ctx);
      const rows = await this.prisma.specialistPlaybook.findMany({ where: { ownerUserId: userId, stageKey: key }, orderBy: { updatedAt: 'desc' }, select: playbookSelect });
      mine = rows.map((row) => ({ ...view(row), issuesHere: checkPlaybook(row, fingerprints) }));
    }
    return {
      data: {
        attached: attached ? {
          id: attached.id, title: attached.title, version: attached.version, instructions: attached.instructions, checklist: attached.checklist, attachedAt: attached.attachedAt,
          author: people?.get(attached.attachedByUserId)?.name ?? null, mine: attached.attachedByUserId === userId, active,
          newerVersion: attached.playbook && attached.playbook.version > attached.version ? attached.playbook.version : null,
        } : null,
        canAttach: lead && editableProject(ctx.project.status),
        canDetach: Boolean(attached) && (attached!.attachedByUserId === userId || (ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role))),
        mine,
      },
    };
  }

  async attach(userId: string, projectId: string, key: string, playbookId: unknown) {
    const ctx = await this.core.load(userId, projectId, 'write', key);
    const assignment = this.core.assignmentFor(ctx, key);
    if (!(assignment?.role === 'lead' && assignment.status === 'active')) throw new ForbiddenException('PLAYBOOK_ONLY_FOR_LEAD');
    if (typeof playbookId !== 'string') throw new NotFoundException('PLAYBOOK_NOT_FOUND');
    const playbook = await this.own(userId, playbookId);
    if (playbook.stageKey !== key) throw new ConflictException('PLAYBOOK_OTHER_STAGE');
    // Checked again against this project: the playbook must not carry this project's data either.
    const issues = checkPlaybook(playbook, await this.fingerprints(ctx));
    if (issues.length) throw new UnprocessableEntityException({ message: 'PLAYBOOK_CHECK_FAILED', issues });
    const stage = this.core.stageOf(ctx, key);
    const data = { playbookId: playbook.id, attachedByUserId: userId, title: playbook.title, version: playbook.version, instructions: playbook.instructions, checklist: playbook.checklist, attachedAt: new Date() };
    await this.prisma.$transaction(async (tx) => {
      await tx.stagePlaybook.upsert({ where: { stageId: stage.id }, create: { projectId, stageId: stage.id, ...data }, update: data });
      await this.core.event(tx, projectId, userId, 'playbook_attached', key, { playbookId: playbook.id, version: playbook.version, title: playbook.title });
    });
    return this.stage(userId, projectId, key);
  }

  async detach(userId: string, projectId: string, key: string) {
    const ctx = await this.core.load(userId, projectId, 'read', key);
    const stage = this.core.stageOf(ctx, key);
    const attached = await this.prisma.stagePlaybook.findUnique({ where: { stageId: stage.id }, select: { id: true, attachedByUserId: true, version: true, title: true } });
    if (!attached) throw new NotFoundException('PLAYBOOK_NOT_ATTACHED');
    const deciding = ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role);
    if (attached.attachedByUserId !== userId && !deciding) throw new ForbiddenException('PLAYBOOK_DETACH_FORBIDDEN');
    await this.prisma.$transaction(async (tx) => {
      await tx.stagePlaybook.delete({ where: { id: attached.id } });
      await this.core.event(tx, projectId, userId, 'playbook_detached', key, { version: attached.version, title: attached.title });
    });
    return this.stage(userId, projectId, key);
  }

  private async own(userId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundException('PLAYBOOK_NOT_FOUND');
    const row = await this.prisma.specialistPlaybook.findFirst({ where: { id, ownerUserId: userId }, select: playbookSelect });
    if (!row) throw new NotFoundException('PLAYBOOK_NOT_FOUND');
    return row;
  }

  /** This project's name and contacts from the goal and the idea passport — unredacted, read on the server only. */
  private async fingerprints(ctx: Awaited<ReturnType<JourneyCore['load']>>) {
    const read = async (key: 'goal' | 'story') => {
      if (!ctx.route.includes(key)) return undefined;
      const stage = this.core.stageOf(ctx, key);
      return (await this.core.versionContent(stage.approvedVersionId ?? stage.currentVersionId))?.content;
    };
    const goal = projectFingerprints(await read('goal') as Partial<Brief> | undefined);
    const story = projectFingerprints(briefFromStory(await read('story') as Story | undefined));
    return [...new Set([...goal, ...story])];
  }
}
