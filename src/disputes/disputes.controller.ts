import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { attachment } from '../analysis/analysis.controller.js';

type Download = { set(headers: Record<string, string>): unknown; send(body: Buffer): unknown };
const sendFile = (response: Download, file: { name: string; mime: string; data: Buffer; etag: string }) => {
  response.set({ 'Content-Type': file.mime, 'Content-Disposition': attachment(file.name), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store', ETag: `"${file.etag}"` });
  response.send(file.data);
};
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffAuthGuard, type StaffRequest } from '../admin/staff-auth.guard.js';
import { StaffRoles, StaffRolesGuard } from '../admin/staff-roles.guard.js';
import { DisputesService } from './disputes.service.js';

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return input;
}

/** Both sides of a stage assignment: the specialist and the project's owner or managers. */
@Controller()
@UseGuards(AuthGuard)
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get('assignments/:assignmentId/disputes')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.disputes.forAssignment(request.user.id, assignmentId);
  }

  @Post('assignments/:assignmentId/disputes')
  open(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string, @Body() raw: unknown) {
    const input = body(raw, ['kind', 'claim', 'amount']);
    return this.disputes.open(request.user.id, assignmentId, { kind: input.kind, claim: input.claim, amount: input.amount ?? null });
  }

  @Post('disputes/:disputeId/messages')
  @HttpCode(200)
  message(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string, @Body() raw: unknown) {
    return this.disputes.message(request.user.id, disputeId, body(raw, ['text']).text);
  }

  /** Multipart: file (screenshot JPG/PNG/WebP or PDF, up to 5 MB) and an optional text. */
  @Post('disputes/:disputeId/attachments')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 4000 } }))
  attach(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string, @UploadedFile() file: { buffer: Buffer; size: number; originalname?: string } | undefined, @Body() raw: Record<string, unknown> | undefined) {
    return this.disputes.attach(request.user.id, disputeId, file, raw?.text);
  }

  @Get('disputes/:disputeId/files/:messageId')
  async file(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string, @Param('messageId') messageId: string, @Res() response: Download) {
    sendFile(response, await this.disputes.file(request.user.id, disputeId, messageId));
  }

  @Post('disputes/:disputeId/withdraw')
  @HttpCode(200)
  withdraw(@Req() request: AuthenticatedRequest, @Param('disputeId') disputeId: string) {
    return this.disputes.withdraw(request.user.id, disputeId);
  }

  @Get('me/disputes')
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: AuthenticatedRequest) {
    return this.disputes.mine(request.user.id);
  }
}

@Controller('admin/disputes')
@UseGuards(StaffAuthGuard, StaffRolesGuard)
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  queue(@Query('status') status?: string) {
    return this.disputes.staffQueue(status === 'closed' ? 'closed' : 'open');
  }

  @Get(':disputeId')
  @Header('Cache-Control', 'no-store')
  @StaffRoles('super_admin', 'operations_auditor')
  detail(@Param('disputeId') disputeId: string, @Req() request: StaffRequest) {
    return this.disputes.staffDetail(request.staff.id, disputeId);
  }

  @Get(':disputeId/files/:messageId')
  @StaffRoles('super_admin', 'operations_auditor')
  async file(@Param('disputeId') disputeId: string, @Param('messageId') messageId: string, @Res() response: Download) {
    sendFile(response, await this.disputes.file(null, disputeId, messageId));
  }

  @Post(':disputeId/messages')
  @HttpCode(200)
  @StaffRoles('super_admin')
  message(@Param('disputeId') disputeId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    return this.disputes.staffMessage(request.staff.id, disputeId, body(raw, ['text']).text);
  }

  @Post(':disputeId/resolve')
  @HttpCode(200)
  @StaffRoles('super_admin')
  resolve(@Param('disputeId') disputeId: string, @Body() raw: unknown, @Req() request: StaffRequest) {
    const input = body(raw, ['outcome', 'note', 'paySpecialist']);
    return this.disputes.resolve(request.staff.id, disputeId, { outcome: input.outcome, note: input.note, paySpecialist: input.paySpecialist ?? null });
  }
}
