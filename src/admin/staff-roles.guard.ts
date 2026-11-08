import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StaffRole } from './staff-auth.service.js';
import type { StaffRequest } from './staff-auth.guard.js';
import { StaffAuthService } from './staff-auth.service.js';

const REQUIRED_ROLES = 'buildpath.staff.roles';
export const StaffRoles = (...roles: StaffRole[]) => SetMetadata(REQUIRED_ROLES, roles);

@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: StaffAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<StaffRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<StaffRequest>();
    if (!roles?.length || !roles.includes(request.staff.role)) {
      await this.auth.recordDenied(request.staff, 'staff.access_denied');
      throw new ForbiddenException('STAFF_ROLE_REQUIRED');
    }
    return true;
  }
}
