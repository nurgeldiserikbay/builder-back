import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { SecurityService } from './security.service.js';

function input(raw: unknown, fields: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return value;
}
/** null when the account has no password (confirmed by a fresh sign-in instead). */
function password(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new BadRequestException('INVALID_PASSWORD');
  return value;
}
function code(value: unknown): string {
  if (typeof value !== 'string' || value.length < 6 || value.length > 12) throw new BadRequestException('TWO_STEP_CODE_INVALID');
  return value;
}

@Controller('me')
@UseGuards(AuthGuard)
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  /** Two-step state, active sessions and the sign-in history of the last 90 days. */
  @Get('security')
  @Header('Cache-Control', 'no-store')
  overview(@Req() request: AuthenticatedRequest) {
    return this.security.overview(request.user.id, request.sessionId);
  }

  @Post('sessions/:sessionId/revoke')
  @HttpCode(200)
  revoke(@Req() request: AuthenticatedRequest, @Param('sessionId') sessionId: string) {
    return this.security.revokeSession(request.user.id, request.sessionId, sessionId);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@Req() request: AuthenticatedRequest) {
    return this.security.revokeOthers(request.user.id, request.sessionId);
  }

  /** { password } → { secret, otpauthUri } to scan. */
  @Post('two-step/setup')
  @HttpCode(200)
  setup(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.security.setup(request.user.id, request.sessionId, password(input(raw, ['password']).password));
  }

  /** { code } → recovery codes (shown once) and the new state. */
  @Post('two-step/enable')
  @HttpCode(200)
  enable(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.security.enable(request.user.id, request.sessionId, code(input(raw, ['code']).code));
  }

  /** { password, code } — a current code or a recovery code. */
  @Post('two-step/disable')
  @HttpCode(200)
  disable(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    const body = input(raw, ['password', 'code']);
    return this.security.disable(request.user.id, request.sessionId, password(body.password), code(body.code));
  }

  @Post('two-step/recovery-codes')
  @HttpCode(200)
  recoveryCodes(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.security.regenerateCodes(request.user.id, request.sessionId, password(input(raw, ['password']).password));
  }

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  notifications(@Req() request: AuthenticatedRequest) {
    return this.security.notifications(request.user.id);
  }

  /** { stages|team|money|site: { telegram, email } } */
  @Put('notifications')
  setNotifications(@Req() request: AuthenticatedRequest, @Body() raw: unknown) {
    return this.security.setNotifications(request.user.id, raw);
  }
}
