import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PublishingController } from './publishing.controller.js';
import { PublishingService } from './publishing.service.js';
import { TelegramLinkService } from './telegram-link.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PublishingController],
  providers: [PublishingService, TelegramLinkService],
})
export class PublishingModule {}
