import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { TelegramBotService } from '../telegram-bot/bot.service.js';
import { MastersController, PublishingController, QuickEditController } from './publishing.controller.js';
import { QuickEditService } from './quick-edit.service.js';
import { MastersService } from './masters.service.js';
import { PublishingService } from './publishing.service.js';
import { TelegramLinkService } from './telegram-link.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [PublishingController, MastersController, QuickEditController],
  providers: [PublishingService, TelegramLinkService, TelegramBotService, MastersService, QuickEditService],
})
export class PublishingModule {}
