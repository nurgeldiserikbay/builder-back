import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { StaffAuthGuard } from './staff-auth.guard.js';
import type { StaffRequest } from './staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from './staff-roles.guard.js';
import { QualityProfilesService, defaultQualityPolicy, parseQualityPolicy } from './quality-profiles.service.js';

function parseText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new BadRequestException(`INVALID_${name.toUpperCase()}`);
  return value.trim();
}
function parseObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return object;
}
function parseVersion(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new BadRequestException('INVALID_VERSION');
  return result;
}

@Controller('admin/quality-profiles')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class QualityProfilesController {
  constructor(private readonly profiles: QualityProfilesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'quality_admin', 'operations_auditor')
  list() { return this.profiles.list(); }

  @Get(':profileKey')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'quality_admin', 'operations_auditor')
  get(@Param('profileKey') profileKey: string) { return this.profiles.get(profileKey); }

  @Post()
  @StaffRoles('super_admin', 'quality_admin')
  create(@Body() raw: unknown, @Req() request: StaffRequest) {
    const body = parseObject(raw, ['name', 'description', 'policy']);
    const name = parseText(body.name, 'name', 1, 120);
    const description = parseText(body.description, 'description', 1, 500);
    const policy = body.policy === undefined ? defaultQualityPolicy() : parseQualityPolicy(body.policy);
    return this.profiles.create({ name, description, policy }, request.staff);
  }

  @Post(':profileKey/versions')
  @StaffRoles('super_admin', 'quality_admin')
  createVersion(@Param('profileKey') profileKey: string, @Req() request: StaffRequest) {
    return this.profiles.createVersion(profileKey, request.staff);
  }

  @Patch(':profileKey/versions/:version')
  @StaffRoles('super_admin', 'quality_admin')
  updateDraft(@Param('profileKey') profileKey: string, @Param('version') version: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const body = parseObject(raw, ['policy']);
    return this.profiles.updateDraft(profileKey, parseVersion(version), { policy: parseQualityPolicy(body.policy) }, request.staff);
  }

  @Post(':profileKey/versions/:version/activate')
  @HttpCode(200)
  @StaffRoles('super_admin', 'quality_admin')
  activate(@Param('profileKey') profileKey: string, @Param('version') version: string, @Req() request: StaffRequest) {
    return this.profiles.activate(profileKey, parseVersion(version), request.staff);
  }
}
