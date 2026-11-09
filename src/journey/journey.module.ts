import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyController } from './journey.controller.js';
import { JourneyService } from './journey.service.js';

@Module({
  imports: [AuthModule],
  controllers: [JourneyController],
  providers: [JourneyService],
})
export class JourneyModule {}
