import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

const createRoles = new Set(['owner', 'admin', 'operator']);

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, workspaceId: string, cursor?: string, limit = 25) {
    if (!this.isUuid(workspaceId)) throw new NotFoundException('WORKSPACE_NOT_FOUND');
    await this.requireWorkspaceMember(userId, workspaceId);
    if (cursor && !this.isUuid(cursor)) throw new NotFoundException('CURSOR_NOT_FOUND');
    const rows = await this.prisma.project.findMany({
      where: { workspaceId, members: { some: { userId, status: 'active' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
  }) {
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
        },
      });
      await tx.projectMember.create({
        data: { projectId: created.id, userId, role: 'owner', status: 'active' },
      });
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
