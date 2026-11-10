import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InviteInfoController, JourneyController } from './journey.controller.js';
import { SpecialistsService } from './specialists.service.js';
import { JourneyService } from './journey.service.js';
import { WorktimeService } from './worktime.service.js';
import { ChangeDeadlinesService } from './change-deadlines.service.js';

@Module({
  imports: [AuthModule],
  controllers: [JourneyController, InviteInfoController],
  providers: [JourneyService, SpecialistsService, WorktimeService, ChangeDeadlinesService],
  exports: [JourneyService, SpecialistsService, WorktimeService],
})
export class JourneyModule {}
