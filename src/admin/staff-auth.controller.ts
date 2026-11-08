import { BadRequestException, Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { StaffRequest } from './staff-auth.guard.js';
import { StaffAuthGuard } from './staff-auth.guard.js';
import { StaffAuthService } from './staff-auth.service.js';

type HttpResponse = { setHeader(name: string, value: string): void };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `buildpath_admin_session=${encodeURIComponent(value)}; Path=/api/v1/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function parseBody(value: unknown): { email: string; password: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'email' && key !== 'password')) throw new BadRequestException('UNKNOWN_FIELD');
  if (typeof body.email !== 'string' || body.email.length < 3 || body.email.length > 254 || !emailPattern.test(body.email)) throw new BadRequestException('INVALID_EMAIL');
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) throw new BadRequestException('INVALID_PASSWORD');
  return { email: body.email, password: body.password };
}

@Controller('admin/auth')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: HttpResponse) {
    const input = parseBody(body);\n    const result = await this.auth.login(input.email, input.password);
    response.setHeader('Set-Cookie', cookie(result.token, 12 * 60 * 60));
    return { data: result.staff };
  }

  @Get('me')
  @UseGuards(StaffAuthGuard)
  me(@Req() request: StaffRequest) { return { data: request.staff }; }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(StaffAuthGuard)
  async logout(@Req() request: StaffRequest, @Res({ passthrough: true }) response: HttpResponse): Promise<void> {
    await this.auth.logout(request.staffSessionId, request.staff);
    response.setHeader('Set-Cookie', cookie('', 0));
  }
}
