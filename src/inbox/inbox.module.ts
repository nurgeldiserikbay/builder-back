import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
