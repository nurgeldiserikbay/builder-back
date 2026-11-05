import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { AuthService, SafeUser } from './auth.service.js';

export interface AuthenticatedRequest {
  headers: IncomingHttpHeaders;
  user: SafeUser;
  sessionId: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookie = request.headers.cookie ?? '';
    const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('buildpath_session='));
    const token = match ? decodeURIComponent(match.slice('buildpath_session='.length)) : '';
    if (!token || token.length > 128) {
      const { UnauthorizedException } = await import('@nestjs/common');
      throw new UnauthorizedException('SESSION_REQUIRED');
    }
    const auth = await this.auth.authenticate(token);
    request.user = auth.user;
    request.sessionId = auth.sessionId;
    return true;
  }
}
