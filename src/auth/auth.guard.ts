import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingHttpHeaders } from 'node:http';
import { AuthService, SafeUser } from './auth.service.js';

export interface AuthenticatedRequest {
  headers: IncomingHttpHeaders;
  user: SafeUser;
  sessionId: string;
}

const ALLOW_WITHOUT_CONSENT = 'buildpath.auth.allowWithoutConsent';
/** Marks a route that works before the user accepts updated legal documents (profile, consent, logout, deletion). */
export const AllowWithoutConsent = () => SetMetadata(ALLOW_WITHOUT_CONSENT, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookie = request.headers.cookie ?? '';
    const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('buildpath_session='));
    const token = match ? match.slice('buildpath_session='.length) : '';
    if (!token || token.length > 128) {
      throw new UnauthorizedException('SESSION_REQUIRED');
    }
    const auth = await this.auth.authenticate(token);
    request.user = auth.user;
    request.sessionId = auth.sessionId;
    if (auth.user.consentRequired && !this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_CONSENT, [context.getHandler(), context.getClass()])) {
      throw new ForbiddenException('CONSENT_REQUIRED');
    }
    return true;
  }
}
