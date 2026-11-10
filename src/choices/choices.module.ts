import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { ChoicesController } from './choices.controller.js';
import { ChoicesService } from './choices.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [ChoicesController],
  providers: [ChoicesService],
})
export class ChoicesModule {}
