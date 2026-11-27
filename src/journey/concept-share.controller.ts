import { BadRequestException, Body, Controller, Get, Header, HttpCode, Ip, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ConceptShareService } from './concept-share.service.js';

const record = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});

/** The team's side: the link, what it shows, and the remarks readers left. */
@Controller('projects/:projectId/concept-share')
@UseGuards(AuthGuard)
export class ConceptShareController {
  constructor(private readonly shares: ConceptShareService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.shares.get(request.user.id, projectId);
  }

  @Put()
  set(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = record(body);
    return this.shares.set(request.user.id, projectId, { enabled: input.enabled, allowComments: input.allowComments, hiddenSections: input.hiddenSections, renew: input.renew });
  }

  @Post('remarks/:commentId/:action')
  @HttpCode(200)
  resolve(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('commentId') commentId: string, @Param('action') action: string) {
    if (action !== 'resolve' && action !== 'reopen') throw new BadRequestException('INVALID_ACTION');
    return this.shares.resolve(request.user.id, projectId, commentId, action === 'resolve');
  }
}

/** The reader's side: no account. Unknown, turned-off and replaced links answer the same: not found. */
@Controller('shared-concept')
export class SharedConceptController {
  constructor(private readonly shares: ConceptShareService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  read(@Param('token') token: string) {
    return this.shares.read(token);
  }

  @Post(':token/remarks')
  @HttpCode(201)
  remark(@Param('token') token: string, @Ip() ip: string, @Body() body: unknown) {
    return this.shares.remark(token, ip, body);
  }
}
