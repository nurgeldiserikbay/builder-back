import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { TelegramBotService } from '../telegram-bot/bot.service.js';
import { PublishingController } from './publishing.controller.js';
import { PublishingService } from './publishing.service.js';
import { TelegramLinkService } from './telegram-link.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [PublishingController],
  providers: [PublishingService, TelegramLinkService, TelegramBotService],
})
export class PublishingModule {}
