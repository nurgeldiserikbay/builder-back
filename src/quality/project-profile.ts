import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Which quality profile judges this project's builds and site checks. Staff maintain the profiles in the console;
 * the owner or a manager picks one with an active version, or goes back to the default. The choice applies to the
 * next build and the next site check — earlier reports keep the profile they were made with.
 */
@Injectable()
export class ProjectProfileService {
  constructor(private readonly prisma: PrismaService) {}

  private async member(userId: string, projectId: string) {
    if (!isUuid(projectId)) throw new NotFoundException('PROJECT_NOT_FOUND');
    const row = await this.prisma.projectMember.findFirst({ where: { projectId, userId, status: 'active' }, select: { role: true, project: { select: { qualityProfileKey: true } } } });
    if (!row) throw new NotFoundException('PROJECT_NOT_FOUND');
    return row;
  }

  async get(userId: string, projectId: string) {
    const { role, project } = await this.member(userId, projectId);
    const profiles = await this.prisma.qualityProfile.findMany({
      where: { versions: { some: { status: 'active' } } }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { key: true, name: true, description: true, isDefault: true, versions: { where: { status: 'active' }, orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
    });
    const options = profiles.map((item) => ({ key: item.key, name: item.name, description: item.description, isDefault: item.isDefault, version: item.versions[0]?.version ?? null }));
    const chosen = options.find((item) => item.key === project.qualityProfileKey) ?? null;
    return { data: { chosen: chosen?.key ?? null, effective: chosen ?? options.find((item) => item.isDefault) ?? null, options, canChange: role === 'owner' || role === 'manager' } };
  }

  async set(userId: string, projectId: string, key: string | null) {
    const { role } = await this.member(userId, projectId);
    if (role !== 'owner' && role !== 'manager') throw new ForbiddenException('QUALITY_PROFILE_FORBIDDEN');
    if (key !== null && !(await this.prisma.qualityProfile.count({ where: { key, versions: { some: { status: 'active' } } } }))) throw new BadRequestException('QUALITY_PROFILE_NOT_FOUND');
    await this.prisma.$transaction([
      this.prisma.project.update({ where: { id: projectId }, data: { qualityProfileKey: key } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'quality_profile_changed', details: { key } } }),
    ]);
    return this.get(userId, projectId);
  }
}

@Controller('projects/:projectId/quality-profile')
@UseGuards(AuthGuard)
export class ProjectProfileController {
  constructor(private readonly profiles: ProjectProfileService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.profiles.get(request.user.id, projectId);
  }

  /** Body: { key: string | null } — null goes back to the default profile. Owner or manager. */
  @Post()
  @HttpCode(200)
  set(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'key')) throw new BadRequestException('INVALID_REQUEST_BODY');
    const key = (raw as { key?: unknown }).key;
    if (key !== null && (typeof key !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(key))) throw new BadRequestException('QUALITY_PROFILE_NOT_FOUND');
    return this.profiles.set(request.user.id, projectId, key as string | null);
  }
}
