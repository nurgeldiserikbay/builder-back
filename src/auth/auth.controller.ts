import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import { AllowWithoutConsent, AuthGuard } from './auth.guard.js';
import { AuthService, SafeUser } from './auth.service.js';

type HttpResponse = { setHeader(name: string, value: string): void };
type ClientRequest = { ip?: string };
const ipOf = (request: ClientRequest) => request.ip ?? '';
const locales = ['en', 'ru', 'kk'] as const;

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('INVALID_REQUEST_BODY');
  return body as Record<string, unknown>;
}
function textField(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new BadRequestException(`INVALID_${key.toUpperCase()}`);
  return value;
}
function rejectUnknown(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
}
function emailField(value: string): string {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new BadRequestException('INVALID_EMAIL');
  return value;
}
export function cookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `buildpath_session=${encodeURIComponent(token)}; Path=/api/v1; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/register')
  @HttpCode(202)
  async register(@Body() raw: unknown, @Req() request: ClientRequest) {
    const body = objectBody(raw);
    rejectUnknown(body, ['email', 'password', 'name', 'locale', 'acceptLegal']);
    const email = emailField(textField(body, 'email', 3, 254));
    const password = textField(body, 'password', 12, 128);
    const name = body.name === undefined ? undefined : textField(body, 'name', 1, 120);
    const locale = body.locale === undefined ? 'en' : body.locale;
    if (!locales.includes(locale as (typeof locales)[number])) throw new BadRequestException('INVALID_LOCALE');
    return { data: await this.auth.register({ email, password, name, locale: locale as 'en' | 'ru' | 'kk', acceptLegal: body.acceptLegal === true }, ipOf(request)) };
  }

  @Post('auth/verify-email')
  @HttpCode(204)
  async verifyEmail(@Body() raw: unknown, @Req() request: ClientRequest): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['token']);
    await this.auth.verifyEmail(textField(body, 'token', 32, 128), ipOf(request));
  }

  /** A new confirmation link. Always 202, so the answer does not reveal which addresses have accounts. */
  @Post('auth/resend-verification')
  @HttpCode(202)
  async resendVerification(@Body() raw: unknown, @Req() request: ClientRequest): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['email']);
    await this.auth.resendVerification(emailField(textField(body, 'email', 3, 254)), ipOf(request));
  }

  /** «Forgot password». Always 202, for the same reason. */
  @Post('auth/forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() raw: unknown, @Req() request: ClientRequest): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['email']);
    await this.auth.requestPasswordReset(emailField(textField(body, 'email', 3, 254)), ipOf(request));
  }

  @Post('auth/reset-password')
  @HttpCode(204)
  async resetPassword(@Body() raw: unknown, @Req() request: ClientRequest): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['token', 'password']);
    await this.auth.resetPassword(textField(body, 'token', 32, 128), textField(body, 'password', 12, 128), ipOf(request));
  }

  @Post('auth/login')
  async login(@Body() raw: unknown, @Req() request: ClientRequest, @Res({ passthrough: true }) response: HttpResponse) {
    const body = objectBody(raw);
    rejectUnknown(body, ['email', 'password']);
    const email = emailField(textField(body, 'email', 3, 254));
    const password = textField(body, 'password', 1, 128);
    const result = await this.auth.login(email, password, ipOf(request));
    response.setHeader('Set-Cookie', cookie(result.token, 30 * 24 * 60 * 60));
    return { data: result.user };
  }

  @Post('auth/telegram-webapp')
  async telegramWebApp(@Body() raw: unknown, @Res({ passthrough: true }) response: HttpResponse) {
    const body = objectBody(raw);
    rejectUnknown(body, ['initData']);
    const result = await this.auth.loginWithTelegramWebApp(textField(body, 'initData', 10, 4096));
    response.setHeader('Set-Cookie', cookie(result.token, 30 * 24 * 60 * 60));
    return { data: result.user };
  }

  @Post('auth/logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @AllowWithoutConsent()
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<void> {
    await this.auth.revokeSession(request.sessionId);
    response.setHeader('Set-Cookie', cookie('', 0));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @AllowWithoutConsent()
  me(@Req() request: AuthenticatedRequest): { data: SafeUser } {
    return { data: request.user };
  }

  /** Interface language for e-mails and Telegram messages; the web interface keeps its own choice in a cookie. */
  @Put('me/locale')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @AllowWithoutConsent()
  async setLocale(@Req() request: AuthenticatedRequest, @Body() raw: unknown): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['locale']);
    if (body.locale !== 'en' && body.locale !== 'ru' && body.locale !== 'kk') throw new BadRequestException('INVALID_LOCALE');
    await this.auth.setLocale(request.user.id, body.locale);
  }

  @Post('me/consent')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @AllowWithoutConsent()
  async consent(@Req() request: AuthenticatedRequest, @Body() raw: unknown): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['termsVersion', 'privacyVersion']);
    await this.auth.acceptConsent(request.user.id, { termsVersion: textField(body, 'termsVersion', 1, 20), privacyVersion: textField(body, 'privacyVersion', 1, 20) });
  }
}
