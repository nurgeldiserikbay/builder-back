import { BadRequestException, Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { capabilityManifest } from '../capabilities/capability-manifest.js';
import { AdminAuditService } from './admin-audit.service.js';
import { StaffAuthGuard } from './staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from './staff-roles.guard.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`INVALID_${field.toUpperCase()}`);
  return date;
}

@Controller('admin')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
@StaffRoles('super_admin', 'quality_admin', 'operations_auditor')
export class AdminController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  getCapabilities() { return { data: capabilityManifest }; }

  @Get('audit-events')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  async listAuditEvents(
    @Query('eventType') eventType?: string,
    @Query('staffId') staffId?: string,
    @Query('from') rawFrom?: string,
    @Query('to') rawTo?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    if (eventType !== undefined && !/^[a-z][a-z0-9_.-]{1,79}$/.test(eventType)) throw new BadRequestException('INVALID_EVENT_TYPE');
    if (staffId !== undefined && !uuid.test(staffId)) throw new BadRequestException('INVALID_STAFF_ID');
    if (cursor !== undefined && !uuid.test(cursor)) throw new BadRequestException('INVALID_AUDIT_CURSOR');
    let limit = 25;
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) throw new BadRequestException('INVALID_LIMIT');
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) throw new BadRequestException('INVALID_LIMIT');
    }
    let from = parseDate(rawFrom, 'from');
    let to = parseDate(rawTo, 'to');
    if (from && to && from > to) throw new BadRequestException('INVALID_DATE_RANGE');
    if (!from && !to) {
      to = new Date();
      from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (from && !to) {
      to = new Date(from.getTime() + MAX_RANGE_MS);
    } else if (!from && to) {
      from = new Date(to.getTime() - MAX_RANGE_MS);
    }
    if (from && to && to.getTime() - from.getTime() > MAX_RANGE_MS) throw new BadRequestException('AUDIT_RANGE_TOO_LARGE');
    return this.audit.list({ eventType, staffId, from, to, cursor, limit });
  }
}
