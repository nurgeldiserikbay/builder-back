import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { FeedbackController, FeedbackGatewayController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [FeedbackController, FeedbackGatewayController],
  providers: [FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
