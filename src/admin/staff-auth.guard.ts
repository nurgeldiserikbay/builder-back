import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { StaffAuthService } from './staff-auth.service.js';
import type { StaffIdentity } from './staff-auth.service.js';

export type StaffRequest = { headers: IncomingHttpHeaders; staff: StaffIdentity; staffSessionId: string };
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(private readonly auth: StaffAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const header = request.headers.cookie ?? '';
    const part = header.split(';').map((item) => item.trim()).find((item) => item.startsWith('buildpath_admin_session='));
    const token = part ? part.slice('buildpath_admin_session='.length) : '';
    const session = await this.auth.authenticate(token);
    if (!session) throw new UnauthorizedException('STAFF_AUTHENTICATION_REQUIRED');
    request.staff = session.staff;
    request.staffSessionId = session.sessionId;
    return true;
  }
}
