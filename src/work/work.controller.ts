import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { WorkService } from './work.service.js';

@Controller('me/work')
@UseGuards(AuthGuard)
export class WorkController {
  constructor(private readonly work: WorkService) {}

  /** «Моя работа»: the specialist's stages, time, money and reviews across projects. */
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest) {
    return this.work.overview(request.user.id);
  }
}
