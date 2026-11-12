import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { DisputesService } from './disputes.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return input;
}

/** Both sides of a stage assignment: the specialist and the project's owner or managers. */
@Controller()
@UseGuards(AuthGuard)
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get('assignments/:assignmentId/disputes')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.disputes.forAssignment(request.user.id, assignmentId);
  }

  @Post('assignments/:assignmentId/disputes')
  open(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string, @Body() raw: unknown) {
    const input = body(raw, ['kind', 'claim', 'amount']);
    return this.disputes.open(request.user.id, assignmentId, { kind: input.kind, claim: input.claim, amount: input.amount ?? null });
  }

  @Post('disputes/:disputeId/messages')
  @HttpCode(200)
  message(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string, @Body() raw: unknown) {
    return this.disputes.message(request.user.id, disputeId, body(raw, ['text']).text);
  }

  @Post('disputes/:disputeId/withdraw')
  @HttpCode(200)
  withdraw(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string) {
    return this.disputes.withdraw(request.user.id, disputeId);
  }

  @Get('me/disputes')
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: AuthenticatedRequest) {
    return this.disputes.mine(request.user.id);
  }
}

@Controller('admin/disputes')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  queue(@Query('status') status?: string) {
    return this.disputes.staffQueue(status === 'closed' ? 'closed' : 'open');
  }

  @Get(':disputeId')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  detail(@Param('disputeId') disputeId: string, @Req() request: StaffRequest) {
    return this.disputes.staffDetail(request.staff.id, disputeId);
  }

  @Post(':disputeId/messages')
  @HttpCode(200)
  @StaffRoles('super_admin')
  message(@Param('disputeId') disputeId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    return this.disputes.staffMessage(request.staff.id, disputeId, body(raw, ['text']).text);
  }

  @Post(':disputeId/resolve')
  @HttpCode(200)
  @StaffRoles('super_admin')
  resolve(@Param('disputeId') disputeId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = body(raw, ['outcome', 'note', 'paySpecialist']);
    return this.disputes.resolve(request.staff.id, disputeId, { outcome: input.outcome, note: input.note, paySpecialist: input.paySpecialist ?? null });
  }
}
