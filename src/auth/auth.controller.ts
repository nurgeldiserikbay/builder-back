import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService, SafeUser } from './auth.service.js';

type HttpResponse = { setHeader(name: string, value: string): void };
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
function cookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `buildpath_session=${encodeURIComponent(token)}; Path=/api/v1; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/register')
  @HttpCode(202)
  async register(@Body() raw: unknown) {
    const body = objectBody(raw);
    rejectUnknown(body, ['email', 'password', 'name', 'locale']);
    const email = emailField(textField(body, 'email', 3, 254));
    const password = textField(body, 'password', 12, 128);
    const name = body.name === undefined ? undefined : textField(body, 'name', 1, 120);
    const locale = body.locale === undefined ? 'en' : body.locale;
    if (!locales.includes(locale as (typeof locales)[number])) throw new BadRequestException('INVALID_LOCALE');
    return { data: await this.auth.register({ email, password, name, locale: locale as 'en' | 'ru' | 'kk' }) };
  }

  @Post('auth/verify-email')
  @HttpCode(204)
  async verifyEmail(@Body() raw: unknown): Promise<void> {
    const body = objectBody(raw);
    rejectUnknown(body, ['token']);
    await this.auth.verifyEmail(textField(body, 'token', 32, 128));
  }

  @Post('auth/login')
  async login(@Body() raw: unknown, @Res({ passthrough: true }) response: HttpResponse) {
    const body = objectBody(raw);
    rejectUnknown(body, ['email', 'password']);
    const email = emailField(textField(body, 'email', 3, 254));
    const password = textField(body, 'password', 1, 128);
    const result = await this.auth.login(email, password);
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
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<void> {
    await this.auth.revokeSession(request.sessionId);
    response.setHeader('Set-Cookie', cookie('', 0));
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest): { data: SafeUser } {
    return { data: request.user };
  }
}
