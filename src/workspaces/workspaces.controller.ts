import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

@Controller('workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: request.user.id, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, createdAt: true, updatedAt: true } },
      },
    });
    return {
      data: memberships.map(({ role, workspace }) => ({ ...workspace, role })),
    };
  }
}
