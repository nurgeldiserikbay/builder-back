import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AllowWithoutConsent, AuthGuard } from '../auth/auth.guard.js';
import { cookie } from '../auth/auth.controller.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { legalDocumentKeys, type LegalDocumentKey } from '../legal/documents.js';
import { AccountService } from './account.service.js';

type HttpResponse = { setHeader(name: string, value: string): void };

function body(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return value;
}
function email(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254) throw new BadRequestException('INVALID_EMAIL');
  return value;
}

@Controller()
export class LegalController {
  constructor(private readonly account: AccountService) {}

  @Get('legal/consent')
  consent() {
    return this.account.consentInfo();
  }

  @Get('legal/:key')
  @Header('Cache-Control', 'public, max-age=300')
  document(@Param('key') key: string) {
    if (!(legalDocumentKeys as readonly string[]).includes(key)) throw new BadRequestException('UNKNOWN_DOCUMENT');
    return this.account.legalDocument(key as LegalDocumentKey);
  }
}

@Controller('me/deletion')
@UseGuards(AuthGuard)
@AllowWithoutConsent()
export class AccountDeletionController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  preview(@Req() request: AuthenticatedRequest) {
    return this.account.deletionPreview(request.user.id);
  }

  @Post()
  @HttpCode(200)
  async delete(@Req() request: AuthenticatedRequest, @Body() raw: unknown, @Res({ passthrough: true }) response: HttpResponse) {
    const input = body(raw, ['password', 'confirm']);
    if (input.confirm !== true) throw new BadRequestException('CONFIRMATION_REQUIRED');
    if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 128) throw new BadRequestException('INVALID_PASSWORD');
    const result = await this.account.requestDeletion(request.user.id, input.password);
    response.setHeader('Set-Cookie', cookie('', 0));
    return result;
  }
}

@Controller('admin')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminPrivacyController {
  constructor(private readonly account: AccountService) {}

  @Get('privacy-settings')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  settings() {
    return this.account.settings();
  }

  @Post('privacy-settings')
  @StaffRoles('super_admin')
  update(@Body() raw: unknown, @Req() request: StaffRequest) {
    const input = body(raw, ['accountRetentionDays']);
    if (typeof input.accountRetentionDays !== 'number') throw new BadRequestException('INVALID_RETENTION_DAYS');
    return this.account.updateRetention(request.staff.id, input.accountRetentionDays);
  }

  @Get('accounts/status')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  status(@Query('email') value?: string) {
    return this.account.staffStatus(email(value));
  }

  @Post('accounts/restore')
  @StaffRoles('super_admin')
  restore(@Body() raw: unknown, @Req() request: StaffRequest) {
    const input = body(raw, ['email']);
    return this.account.staffRestore(request.staff.id, email(input.email));
  }
}
