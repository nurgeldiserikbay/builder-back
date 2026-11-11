import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
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

  @Post('top-ups/:topUpId/refund')
  @HttpCode(200)
  refund(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('topUpId') topUpId: string, @Body() raw: unknown) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'amount' && key !== 'reason') || typeof input.amount !== 'number' || (input.reason !== undefined && typeof input.reason !== 'string')) throw new BadRequestException('REFUND_AMOUNT_INVALID');
    return this.payments.requestRefund(request.user.id, projectId, topUpId, input.amount, (input.reason as string | undefined) ?? '');
  }

  @Delete('top-ups/:topUpId/refund')
  @HttpCode(200)
  cancelRefund(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('topUpId') topUpId: string) {
    return this.payments.cancelRefund(request.user.id, projectId, topUpId);
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

  @Get('mock/:orderId')
  async mockPage(@Param('orderId') topUpId: string, @Res() response: RawResponse) {
    const html = await this.payments.mockPage(topUpId);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).send(html);
  }

  @Post('mock/:orderId')
  async mockComplete(@Param('orderId') topUpId: string, @Body() raw: unknown, @Res() response: RawResponse) {
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
    if (!input || Object.keys(input).some((key) => !['mode', 'minTopUp', 'specialistFeePercent'].includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
    if (input.mode !== 'off' && input.mode !== 'prepaid') throw new BadRequestException('INVALID_MODE');
    if (typeof input.minTopUp !== 'number') throw new BadRequestException('INVALID_MIN_TOP_UP');
    const fee = input.specialistFeePercent === undefined ? 0 : input.specialistFeePercent;
    if (typeof fee !== 'number') throw new BadRequestException('INVALID_SPECIALIST_FEE');
    return this.payments.updateBillingMode(request.staff.id, input.mode, input.minTopUp, fee);
  }
}

@Controller()
@UseGuards(AuthGuard)
export class SpecialistPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('me/payout-details')
  @Header('Cache-Control', 'no-store')
  details(@Req() request: AuthenticatedRequest) {
    return this.payments.payoutDetails(request.user.id);
  }

  @Put('me/payout-details')
  save(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'holderName' && key !== 'iban') || typeof input.holderName !== 'string' || typeof input.iban !== 'string' || input.iban.length > 60) throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.payments.savePayoutDetails(request.user.id, { holderName: input.holderName, iban: input.iban });
  }

  @Delete('me/payout-details')
  @HttpCode(200)
  remove(@Req() request: AuthenticatedRequest) {
    return this.payments.deletePayoutDetails(request.user.id);
  }

  @Get('projects/:projectId/receipts/:kind/:id')
  @Header('Cache-Control', 'no-store')
  receipt(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('kind') kind: string, @Param('id') id: string) {
    if (kind !== 'top-up' && kind !== 'stage') throw new BadRequestException('RECEIPT_NOT_FOUND');
    return this.payments.receipt(request.user.id, projectId, kind, id);
  }

  @Post('projects/:projectId/payments/:paymentId/checkout')
  @HttpCode(200)
  checkout(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('paymentId') paymentId: string) {
    return this.payments.stageCheckout(request.user.id, projectId, paymentId);
  }
}

@Controller('admin/payouts')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminPayoutsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  list() {
    return this.payments.payoutQueue();
  }

  @Post(':paymentId/account')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin')
  account(@Param('paymentId') paymentId: string, @Req() request: StaffRequest) {
    return this.payments.revealPayoutAccount(request.staff.id, paymentId);
  }

  @Post(':paymentId/paid-out')
  @HttpCode(200)
  @StaffRoles('super_admin')
  paidOut(@Param('paymentId') paymentId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'reference') || typeof input.reference !== 'string') throw new BadRequestException('PAYOUT_REFERENCE_INVALID');
    return this.payments.markPaidOut(request.staff.id, paymentId, input.reference);
  }

  @Post(':paymentId/refund')
  @HttpCode(200)
  @StaffRoles('super_admin')
  refund(@Param('paymentId') paymentId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => key !== 'reference' && key !== 'note') || typeof input.note !== 'string' || (input.reference !== undefined && input.reference !== null && typeof input.reference !== 'string')) throw new BadRequestException('INVALID_REQUEST_BODY');
    return this.payments.refundStagePayment(request.staff.id, paymentId, { reference: (input.reference as string | null | undefined) ?? null, note: input.note });
  }
}

@Controller('admin/refunds')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminRefundsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  list() {
    return this.payments.refundQueue();
  }

  @Post(':topUpId')
  @HttpCode(200)
  @StaffRoles('super_admin')
  decide(@Param('topUpId') topUpId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!input || Object.keys(input).some((key) => !['decision', 'reference', 'note'].includes(key)) || (input.decision !== 'refund' && input.decision !== 'reject')) throw new BadRequestException('INVALID_REQUEST_BODY');
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    return this.payments.decideRefund(request.staff.id, topUpId, input.decision, { reference: text(input.reference), note: text(input.note) });
  }
}
