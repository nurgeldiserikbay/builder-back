import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { TelegramGroupController } from './telegram-group.controller.js';
import { TelegramGroupService } from './telegram-group.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [TelegramGroupController],
  providers: [TelegramGroupService],
  exports: [TelegramGroupService],
})
export class TelegramGroupModule {}
