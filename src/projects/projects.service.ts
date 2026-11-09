import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
      },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
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
