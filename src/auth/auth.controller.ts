import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import { AllowWithoutConsent, AuthGuard } from './auth.guard.js';
import { AuthService, SafeUser } from './auth.service.js';
import { GoogleAuthError } from './google-oauth.js';

type HttpResponse = { setHeader(name: string, value: string): void };
type ClientRequest = { ip?: string; headers?: { cookie?: string; 'user-agent'?: string } };
type RedirectResponse = HttpResponse & { redirect(status: number, url: string): void };
const GOOGLE_COOKIE = 'buildpath_google';
const ipOf = (request: ClientRequest) => request.ip ?? '';
const agentOf = (request: ClientRequest) => (typeof request.headers?.['user-agent'] === 'string' ? request.headers['user-agent'].slice(0, 300) : null);
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

/** Ties a Google sign-in to the browser that started it; lives ten minutes and only on the Google callback path. */
function googleCookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GOOGLE_COOKIE}=${encodeURIComponent(value)}; Path=/api/v1/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
function cookieValue(request: ClientRequest, name: string): string | null {
  const part = (request.headers?.cookie ?? '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  if (!part) return null;
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch { return null; }
}
const queryText = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : null);
/** Back to the app on the same origin; the path was checked when the sign-in started. */
const appPath = (path: string) => `${(process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '')}${path}`;

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
    const result = await this.auth.login(email, password, ipOf(request), agentOf(request));
    // Two-step sign-in: no session yet, only a challenge for POST auth/login/two-step.
    if ('twoStep' in result) return { data: { twoStepRequired: true, challenge: result.twoStep.challenge, expiresAt: result.twoStep.expiresAt } };
    response.setHeader('Set-Cookie', cookie(result.token, 30 * 24 * 60 * 60));
    return { data: result.user };
  }

  /** Second step: { challenge, code } — six digits from the authenticator app or a recovery code. */
  @Post('auth/login/two-step')
  @HttpCode(200)
  async loginTwoStep(@Body() raw: unknown, @Req() request: ClientRequest, @Res({ passthrough: true }) response: HttpResponse) {
    const body = objectBody(raw);
    rejectUnknown(body, ['challenge', 'code']);
    const result = await this.auth.loginSecondStep(textField(body, 'challenge', 20, 100), textField(body, 'code', 6, 12), ipOf(request), agentOf(request));
    response.setHeader('Set-Cookie', cookie(result.token, 30 * 24 * 60 * 60));
    return { data: { ...result.user, recoveryCodesLeft: result.recoveryCodesLeft } };
  }

  @Post('auth/telegram-webapp')
  async telegramWebApp(@Body() raw: unknown, @Req() request: ClientRequest, @Res({ passthrough: true }) response: HttpResponse) {
    const body = objectBody(raw);
    rejectUnknown(body, ['initData']);
    const result = await this.auth.loginWithTelegramWebApp(textField(body, 'initData', 10, 4096), { ip: ipOf(request), userAgent: agentOf(request) });
    response.setHeader('Set-Cookie', cookie(result.token, 30 * 24 * 60 * 60));
    return { data: result.user };
  }

  /** Which outside sign-in methods are on (the sign-in page shows only those). */
  @Get('auth/providers')
  providers() {
    return { data: this.auth.providers() };
  }

  /** «Continue with Google»: sends the browser to Google. Problems come back to the sign-in page as ?error=CODE. */
  @Get('auth/google/start')
  async googleStart(@Query() query: Record<string, unknown>, @Req() request: ClientRequest, @Res() response: RedirectResponse) {
    try {
      const started = await this.auth.startGoogle({ next: query.next, locale: queryText(query.locale, 5) ?? 'en' }, ipOf(request));
      response.setHeader('Set-Cookie', googleCookie(started.binding, 600));
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(302, started.url);
    } catch (error) {
      const code = error instanceof HttpException && typeof error.message === 'string' && /^[A-Z_]+$/.test(error.message) ? error.message : 'GOOGLE_FAILED';
      response.redirect(302, appPath(`/login?error=${code}`));
    }
  }

  /** Google sends the browser back here with a one-time code. */
  @Get('auth/google/callback')
  async googleCallback(@Query() query: Record<string, unknown>, @Req() request: ClientRequest, @Res() response: RedirectResponse) {
    const clear = googleCookie('', 0);
    response.setHeader('Cache-Control', 'no-store');
    try {
      const result = await this.auth.finishGoogle({
        code: queryText(query.code, 2048), state: queryText(query.state, 100), error: queryText(query.error, 100),
        binding: cookieValue(request, GOOGLE_COOKIE),
      }, ipOf(request), fetch, agentOf(request));
      response.setHeader('Set-Cookie', [cookie(result.token, 30 * 24 * 60 * 60), clear] as unknown as string);
      response.redirect(302, appPath(result.next));
    } catch (error) {
      const code = error instanceof GoogleAuthError ? error.code : 'GOOGLE_FAILED';
      if (!(error instanceof GoogleAuthError)) console.warn('Google sign-in failed', error instanceof Error ? error.message : error);
      response.setHeader('Set-Cookie', clear);
      response.redirect(302, appPath(`/login?error=${code}`));
    }
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
