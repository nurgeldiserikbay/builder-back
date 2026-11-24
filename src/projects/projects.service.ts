import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ROUTE_CATALOG_VERSION, projectTypeOf, stageDefinitions, type StageKey } from '../journey/catalog.js';
import { initialStatuses } from '../journey/stage-state.js';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../database/prisma.service.js';

const createRoles = new Set(['owner', 'admin', 'operator']);

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService) {}

  async list(userId: string, workspaceId: string, cursor?: string, limit = 25) {
    if (!this.isUuid(workspaceId)) throw new NotFoundException('WORKSPACE_NOT_FOUND');
    await this.requireWorkspaceMember(userId, workspaceId);
    if (cursor && !this.isUuid(cursor)) throw new NotFoundException('CURSOR_NOT_FOUND');
    const rows = await this.prisma.project.findMany({
      where: { workspaceId, members: { some: { userId, status: 'active' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        workspaceId: true,
        name: true,
        summary: true,
        startMode: true,
        status: true,
        locale: true,
        projectType: true,
        createdAt: true,
        updatedAt: true,
        stages: { select: { stageKey: true, status: true, updatedAt: true }, orderBy: { position: 'asc' } },
        publication: { select: { slug: true, status: true, monitorStatus: true } },
        _count: {
          select: {
            members: { where: { status: 'active' } },
            assignments: { where: { status: 'active' } },
            changeNotices: { where: { status: { in: ['open', 'discussing'] } } },
          },
        },
      },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(({ stages, publication, _count, ...project }) => ({
      ...project,
      overview: projectOverview(stages, publication, _count),
    }));
    return {
      data,
      meta: { nextCursor: hasMore ? data[data.length - 1]?.id ?? null : null },
    };
  }

  async create(userId: string, input: {
    workspaceId: string;
    name: string;
    summary?: string;
    startMode: 'build' | 'improve' | 'design_implementation' | 'analysis_only';
    locale: 'en' | 'ru' | 'kk';
    projectType?: string;
    startStageKey?: string;
  }) {
    const type = input.projectType ? projectTypeOf(input.projectType) : null;
    if (input.projectType && !type) throw new BadRequestException('INVALID_PROJECT_TYPE');
    if (input.startStageKey && !type?.stages.includes(input.startStageKey as StageKey)) throw new BadRequestException('INVALID_START_STAGE');
    if (type) await this.billing.assertCanCreateProject(userId);
    if (!this.isUuid(input.workspaceId)) throw new NotFoundException('WORKSPACE_NOT_FOUND');
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId } },
      select: { role: true, status: true },
    });
    if (!membership || membership.status !== 'active') throw new NotFoundException('WORKSPACE_NOT_FOUND');
    if (!createRoles.has(membership.role)) throw new ForbiddenException('PROJECT_CREATE_FORBIDDEN');

    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          workspaceId: input.workspaceId,
          ownerUserId: userId,
          name: input.name.trim(),
          summary: input.summary?.trim() || null,
          startMode: input.startMode,
          locale: input.locale,
          ...(type ? { projectType: type.key, routeVersion: ROUTE_CATALOG_VERSION, startStageKey: input.startStageKey ?? null, status: 'active' as const } : {}),
        },
        select: {
        id: true,
        workspaceId: true,
        name: true,
        summary: true,
        startMode: true,
        status: true,
        locale: true,
        projectType: true,
        createdAt: true,
        updatedAt: true,
      },
      });
      await tx.projectMember.create({
        data: { projectId: created.id, userId, role: 'owner', status: 'active' },
      });
      if (type) {
        const statuses = initialStatuses(type.stages, (input.startStageKey as StageKey | undefined) ?? null);
        await tx.projectStage.createMany({
          data: type.stages.map((key, position) => ({
            projectId: created.id, stageKey: key, position, status: statuses[key] ?? 'locked', definitionVersion: stageDefinitions[key].version,
          })),
        });
        await tx.projectEvent.create({ data: { projectId: created.id, actorUserId: userId, type: 'route_created', details: { projectType: type.key, routeVersion: ROUTE_CATALOG_VERSION, startStageKey: input.startStageKey ?? null } } });
      }
      return created;
    });
    return { data: project };
  }

  /**
   * A project started as «Только анализ» gets a development route: the owner picks the type (and a later starting
   * stage). Reports, files and the team stay; from now on it counts as a project on the owner's plan.
   */
  async addRoute(userId: string, projectId: string, input: { projectType: string; startStageKey?: string; locale?: 'en' | 'ru' | 'kk' }) {
    if (!this.isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({ where: { id: projectId, members: { some: { userId, status: 'active' } } }, select: { id: true, ownerUserId: true, projectType: true, status: true } });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    if (project.ownerUserId !== userId) throw new ForbiddenException('ROUTE_OWNER_ONLY');
    if (project.projectType) throw new ConflictException('PROJECT_HAS_ROUTE');
    if (project.status === 'archived') throw new ConflictException('PROJECT_NOT_ACTIVE');
    const type = projectTypeOf(input.projectType);
    if (!type) throw new BadRequestException('INVALID_PROJECT_TYPE');
    if (input.startStageKey && !type.stages.includes(input.startStageKey as StageKey)) throw new BadRequestException('INVALID_START_STAGE');
    await this.billing.assertCanCreateProject(userId);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.project.updateMany({
        where: { id: projectId, projectType: null },
        data: { projectType: type.key, routeVersion: ROUTE_CATALOG_VERSION, startStageKey: input.startStageKey ?? null, status: 'active', startMode: 'improve', ...(input.locale ? { locale: input.locale } : {}) },
      });
      if (changed.count !== 1) throw new ConflictException('PROJECT_HAS_ROUTE');
      const statuses = initialStatuses(type.stages, (input.startStageKey as StageKey | undefined) ?? null);
      await tx.projectStage.createMany({
        data: type.stages.map((key, position) => ({ projectId, stageKey: key, position, status: statuses[key] ?? 'locked', definitionVersion: stageDefinitions[key].version })),
      });
      await tx.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'route_created', details: { projectType: type.key, routeVersion: ROUTE_CATALOG_VERSION, startStageKey: input.startStageKey ?? null, from: 'analysis_only' } } });
    });
    return this.get(userId, projectId);
  }

  async get(userId: string, projectId: string) {
    if (!this.isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        members: { some: { userId, status: 'active' } },
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        summary: true,
        startMode: true,
        status: true,
        locale: true,
        projectType: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!project) throw new NotFoundException('PROJECT_NOT_FOUND');
    return { data: project };
  }

  private async requireWorkspaceMember(userId: string, workspaceId: string): Promise<void> {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'active') throw new NotFoundException('WORKSPACE_NOT_FOUND');
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}

const doneStatuses = new Set(['approved', 'imported', 'skipped']);
const waitingStatuses = new Set(['in_review', 'changes_requested', 'stale', 'blocked']);

/**
 * What a projects table needs without opening each project: progress, the stage being worked on now,
 * how many things wait for a decision, the team size and the publication state. Read-only, derived from stored state.
 */
export function projectOverview(
  stages: Array<{ stageKey: string; status: string; updatedAt: Date }>,
  publication: { slug: string; status: string; monitorStatus: string } | null,
  counts: { members: number; assignments: number; changeNotices: number },
) {
  const accepted = stages.filter((stage) => doneStatuses.has(stage.status)).length;
  const current = stages.find((stage) => !doneStatuses.has(stage.status) && stage.status !== 'locked') ?? null;
  const lastActivity = stages.reduce<Date | null>((latest, stage) => (!latest || stage.updatedAt > latest ? stage.updatedAt : latest), null);
  return {
    stagesTotal: stages.length,
    stagesAccepted: accepted,
    currentStage: current ? { key: current.stageKey, status: current.status } : null,
    waiting: stages.filter((stage) => waitingStatuses.has(stage.status)).length + counts.changeNotices,
    openChanges: counts.changeNotices,
    people: counts.members + counts.assignments,
    publication: publication ? { slug: publication.slug, status: publication.status, monitor: publication.monitorStatus } : null,
    lastActivityAt: lastActivity,
  };
}
