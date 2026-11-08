import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminAuditService } from './admin-audit.service.js';
import { QualityProfilesController } from './quality-profiles.controller.js';
import { QualityProfilesService } from './quality-profiles.service.js';
import { StaffAuthController } from './staff-auth.controller.js';
import { StaffAuthGuard } from './staff-auth.guard.js';
import { StaffAuthService } from './staff-auth.service.js';
import { StaffRolesGuard } from './staff-roles.guard.js';

@Module({
  controllers: [StaffAuthController, AdminController, QualityProfilesController],
  providers: [StaffAuthService, StaffAuthGuard, StaffRolesGuard, QualityProfilesService, AdminAuditService],
})
export class StaffAuthModule {}
