import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { capabilityManifest } from '../capabilities/capability-manifest.js';
import { StaffAuthGuard } from './staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from './staff-roles.guard.js';

@Controller('admin')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
@StaffRoles('super_admin', 'quality_admin', 'operations_auditor')
export class AdminController {
  @Get('capabilities')\n  @Header('Cache-Control', 'no-store')
  getCapabilities() { return { data: capabilityManifest }; }
}
