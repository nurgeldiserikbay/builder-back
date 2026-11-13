import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { TeamController, TeamInviteInfoController } from './team.controller.js';
import { TeamService } from './team.service.js';
import { OwnershipService } from './ownership.service.js';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [TeamController, TeamInviteInfoController],
  providers: [TeamService, OwnershipService],
})
export class TeamModule {}
