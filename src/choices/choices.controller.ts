import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ChoicesService } from './choices.service.js';

function body(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return value;
}
const str = (value: unknown, code: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequestException(code);
  return value.trim();
};

@Controller('projects/:projectId')
@UseGuards(AuthGuard)
export class ChoicesController {
  constructor(private readonly choices: ChoicesService) {}

  @Get('choices/:cardKey')
  @Header('Cache-Control', 'no-store')
  card(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('cardKey') cardKey: string) {
    return this.choices.card(request.user.id, projectId, cardKey);
  }

  @Post('choices/:cardKey')
  @HttpCode(200)
  choose(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('cardKey') cardKey: string, @Body() raw: unknown) {
    const input = body(raw, ['optionKey', 'reason']);
    const reason = input.reason === undefined || input.reason === null || input.reason === '' ? null : str(input.reason, 'INVALID_REASON', 500);
    return this.choices.choose(request.user.id, projectId, cardKey, str(input.optionKey, 'CHOICE_OPTION_INVALID', 40), reason);
  }

  @Post('choices/:cardKey/steps')
  @HttpCode(200)
  step(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('cardKey') cardKey: string, @Body() raw: unknown) {
    const input = body(raw, ['stepKey', 'done']);
    if (typeof input.done !== 'boolean') throw new BadRequestException('INVALID_DONE');
    return this.choices.markStep(request.user.id, projectId, cardKey, str(input.stepKey, 'CHOICE_STEP_INVALID', 40), input.done);
  }

  @Post('repository')
  @HttpCode(200)
  connect(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['provider', 'repoUrl', 'token']);
    if (input.provider !== 'github' && input.provider !== 'gitlab') throw new BadRequestException('REPO_PROVIDER_INVALID');
    return this.choices.connect(request.user.id, projectId, { provider: input.provider, repoUrl: str(input.repoUrl, 'REPO_URL_INVALID', 500), token: str(input.token, 'REPO_TOKEN_INVALID', 400) });
  }

  @Delete('repository')
  @HttpCode(200)
  disconnect(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.choices.disconnect(request.user.id, projectId);
  }

  @Get('repository/push')
  @Header('Cache-Control', 'no-store')
  preview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.choices.pushPreview(request.user.id, projectId);
  }

  @Post('repository/push')
  @HttpCode(200)
  push(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['confirm']);
    return this.choices.push(request.user.id, projectId, input.confirm === true);
  }

  @Post('deployment/verify')
  @HttpCode(200)
  verify(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() raw: unknown) {
    const input = body(raw, ['url']);
    const url = input.url === undefined || input.url === null || input.url === '' ? null : str(input.url, 'SITE_URL_INVALID', 500);
    return this.choices.verifyDeployment(request.user.id, projectId, url);
  }

  @Get('deployment/package')
  @Header('Cache-Control', 'no-store')
  package(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.choices.serverPackage(request.user.id, projectId);
  }
}
