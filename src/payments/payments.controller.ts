import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { PaymentsService } from './payments.service.js';

type RawResponse = { status: (code: number) => RawResponse; setHeader: (name: string, value: string) => void; send: (body: string) => void; redirect: (status: number, url: string) => void };

function fields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
}

@Controller('projects/:projectId/wallet')
@UseGuards(AuthGuard)
export class ProjectWalletController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.payments.wallet(request.user.id, projectId);
  }

  @Post('top-ups')
  @HttpCode(200)
  topUp(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'amount') || typeof input.amount !== 'number') throw new BadRequestException('TOP_UP_AMOUNT_INVALID');
    return this.payments.startTopUp(request.user.id, projectId, input.amount);
  }
}

/** Provider callbacks and the development payment page. No session: callbacks are checked by signature. */
@Controller('payments')
export class PaymentsCallbackController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('freedompay/result')
  async freedomResult(@Body() raw: unknown, @Res() response: RawResponse) {
    const xml = await this.payments.freedomResult(fields(raw));
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.status(xml ? 200 : 404).send(xml);
  }

  @Get('mock/:topUpId')
  async mockPage(@Param('topUpId') topUpId: string, @Res() response: RawResponse) {
    const html = await this.payments.mockPage(topUpId);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).send(html);
  }

  @Post('mock/:topUpId')
  async mockComplete(@Param('topUpId') topUpId: string, @Body() raw: unknown, @Res() response: RawResponse) {
    response.redirect(303, await this.payments.mockComplete(topUpId, fields(raw).result ?? ''));
  }
}

@Controller('admin/billing-mode')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminBillingModeController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  get() {
    return this.payments.billingModeView();
  }

  @Post()
  @StaffRoles('super_admin')
  update(@Body() raw: unknown, @Req() request: StaffRequest) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'mode' && key !== 'minTopUp')) throw new BadRequestException('UNKNOWN_FIELD');
    if (input.mode !== 'off' && input.mode !== 'prepaid') throw new BadRequestException('INVALID_MODE');
    if (typeof input.minTopUp !== 'number') throw new BadRequestException('INVALID_MIN_TOP_UP');
    return this.payments.updateBillingMode(request.staff.id, input.mode, input.minTopUp);
  }
}
