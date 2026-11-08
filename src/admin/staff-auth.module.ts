import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { StaffAuthController } from './staff-auth.controller.js';
import { StaffAuthGuard } from './staff-auth.guard.js';
import { StaffAuthService } from './staff-auth.service.js';
import { StaffRolesGuard } from './staff-roles.guard.js';

@Module({
  controllers: [StaffAuthController, AdminController],
  providers: [StaffAuthService, StaffAuthGuard, StaffRolesGuard],
})
export class StaffAuthModule {}
