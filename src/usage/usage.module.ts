import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { UsageController, UsageGatewayController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [UsageController, UsageGatewayController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
