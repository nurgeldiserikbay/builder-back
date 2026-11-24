import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { RequestsService } from './requests.service.js';

@Controller()
@UseGuards(AuthGuard)
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  /** Owner or manager: requests of a stage with responses. */
  @Get('projects/:projectId/stages/:stageKey/requests')
  @Header('Cache-Control', 'no-store')
  forStage(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') stageKey: string) {
    return this.requests.forStage(request.user.id, projectId, stageKey);
  }

  /** Body: { role, description, payKind: fixed|hourly|any, budget (tenge) | null, days }. */
  @Post('projects/:projectId/stages/:stageKey/requests')
  create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('stageKey') stageKey: string, @Body() raw: unknown) {
    return this.requests.create(request.user.id, projectId, stageKey, raw);
  }

  @Post('projects/:projectId/requests/:requestId/cancel')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('requestId') requestId: string) {
    return this.requests.cancel(request.user.id, projectId, requestId);
  }

  @Post('projects/:projectId/requests/:requestId/responses/:responseId/choose')
  @HttpCode(200)
  choose(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('requestId') requestId: string, @Param('responseId') responseId: string) {
    return this.requests.choose(request.user.id, projectId, requestId, responseId);
  }

  @Post('projects/:projectId/requests/:requestId/responses/:responseId/decline')
  @HttpCode(200)
  decline(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('requestId') requestId: string, @Param('responseId') responseId: string) {
    return this.requests.decline(request.user.id, projectId, requestId, responseId);
  }

  /** The board of open requests for specialists. ?stageKey= filters; ?mine=1 — only those the caller responded to. */
  @Get('stage-requests')
  @Header('Cache-Control', 'no-store')
  board(@Req() request: AuthenticatedRequest, @Query('stageKey') stageKey?: string, @Query('mine') mine?: string) {
    return this.requests.board(request.user.id, { stageKey: stageKey || undefined, mine: mine === '1' });
  }

  /** Body: { message, payKind: fixed|hourly, fixedAmount | hourlyRate + hourLimit, days }. Sends or updates the caller's response. */
  @Post('stage-requests/:requestId/responses')
  @HttpCode(200)
  respond(@Req() request: AuthenticatedRequest, @Param('requestId') requestId: string, @Body() raw: unknown) {
    return this.requests.respond(request.user.id, requestId, raw);
  }

  @Post('stage-requests/:requestId/responses/withdraw')
  @HttpCode(200)
  withdraw(@Req() request: AuthenticatedRequest, @Param('requestId') requestId: string) {
    return this.requests.withdraw(request.user.id, requestId);
  }

  @Get('me/stage-responses')
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: AuthenticatedRequest) {
    return this.requests.myResponses(request.user.id);
  }
}
