import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { TeamService } from './team.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return input;
}
const str = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(code);
  return value;
};

@Controller()
@UseGuards(AuthGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('projects/:projectId/team')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.team.list(request.user.id, projectId);
  }

  @Post('projects/:projectId/team/invitations')
  invite(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['email', 'role', 'stageKeys']);
    return this.team.invite(request.user.id, projectId, { email: str(input.email, 'EMAIL_INVALID'), role: str(input.role, 'ROLE_INVALID'), stageKeys: input.stageKeys });
  }

  @Post('projects/:projectId/team/invitations/:invitationId/revoke')
  @HttpCode(200)
  revoke(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('invitationId') invitationId: string) {
    return this.team.revokeInvitation(request.user.id, projectId, invitationId);
  }

  @Post('projects/:projectId/team/members/:memberId/role')
  @HttpCode(200)
  role(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('memberId') memberId: string, @Body() raw: unknown) {
    const input = body(raw, ['role']);
    return this.team.changeRole(request.user.id, projectId, memberId, str(input.role, 'ROLE_INVALID'));
  }

  @Post('projects/:projectId/team/members/:memberId/stages')
  @HttpCode(200)
  stages(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('memberId') memberId: string, @Body() raw: unknown) {
    const input = body(raw, ['stageKeys']);
    return this.team.setStages(request.user.id, projectId, memberId, input.stageKeys);
  }

  @Post('projects/:projectId/team/members/:memberId/remove')
  @HttpCode(200)
  remove(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('memberId') memberId: string) {
    return this.team.remove(request.user.id, projectId, memberId);
  }

  @Get('me/team-projects')
  @Header('Cache-Control', 'no-store')
  shared(@Req() request: AuthenticatedRequest) {
    return this.team.shared(request.user.id);
  }

  @Post('team-invites/:token/accept')
  @HttpCode(200)
  accept(@Req() request: AuthenticatedRequest, @Param('token') token: string) {
    return this.team.accept(request.user.id, request.user.email, token);
  }
}

/** The invitation page reads this before the person signs in. */
@Controller()
export class TeamInviteInfoController {
  constructor(private readonly team: TeamService) {}

  @Get('team-invites/:token')
  @Header('Cache-Control', 'no-store')
  info(@Param('token') token: string) {
    return this.team.info(token);
  }
}
