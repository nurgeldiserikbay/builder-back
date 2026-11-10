import { BadRequestException, Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { BudgetService } from './budget.service.js';

@Controller('projects/:projectId/budget')
@UseGuards(AuthGuard)
export class ProjectBudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.budget.projectBudget(request.user.id, projectId);
  }
}

@Controller('admin/ai-pricing')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminAiPricingController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  get() {
    return this.budget.pricing();
  }

  @Post()
  @StaffRoles('super_admin')
  update(@Body() raw: unknown, @Req() request: StaffRequest) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'inputPerMillion' && key !== 'outputPerMillion')) throw new BadRequestException('UNKNOWN_FIELD');
    if (typeof input.inputPerMillion !== 'number' || typeof input.outputPerMillion !== 'number') throw new BadRequestException('INVALID_PRICE');
    return this.budget.updatePricing(request.staff.id, input.inputPerMillion, input.outputPerMillion);
  }
}
