import { BadRequestException, Body, Controller, Get, Header, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { BillingService } from './billing.service.js';
import { plans, type PlanKey } from './plans.js';

@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('me/plan')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: AuthenticatedRequest) {
    return this.billing.overview(request.user.id);
  }

  @Get('plans')
  catalog() {
    return { data: this.billing.catalog() };
  }
}

@Controller('admin/accounts')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminPlansController {
  constructor(private readonly billing: BillingService) {}

  @Get('plan')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  lookup(@Query('email') email?: string) {
    if (typeof email !== 'string' || email.length < 3 || email.length > 254) throw new BadRequestException('INVALID_EMAIL');
    return this.billing.staffLookup(email);
  }

  @Post('plan')
  @StaffRoles('super_admin')
  assign(@Body() raw: unknown, @Req() request: StaffRequest) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => !['email', 'planKey', 'validUntil', 'note'].includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
    if (typeof body.email !== 'string' || body.email.length < 3 || body.email.length > 254) throw new BadRequestException('INVALID_EMAIL');
    if (typeof body.planKey !== 'string' || !(body.planKey in plans)) throw new BadRequestException('INVALID_PLAN');
    let validUntil: Date | null = null;
    if (body.validUntil !== undefined && body.validUntil !== null) {
      validUntil = typeof body.validUntil === 'string' ? new Date(body.validUntil) : new Date(NaN);
      if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) throw new BadRequestException('INVALID_VALID_UNTIL');
    }
    const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 500) || null;
    return this.billing.assign(request.staff.id, { email: body.email, planKey: body.planKey as PlanKey, validUntil, note });
  }
}
