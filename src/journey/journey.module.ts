import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InviteInfoController, JourneyController } from './journey.controller.js';
import { SpecialistsService } from './specialists.service.js';
import { JourneyService } from './journey.service.js';
import { JourneyCore } from './journey-core.js';
import { StageAiService } from './stage-ai.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { WorktimeService } from './worktime.service.js';
import { ChangeDeadlinesService } from './change-deadlines.service.js';
import { CommentsService } from './comments.service.js';

@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [JourneyController, InviteInfoController],
  providers: [JourneyCore, StageAiService, ChangeNoticesService, JourneyService, SpecialistsService, WorktimeService, ChangeDeadlinesService, CommentsService],
  exports: [JourneyService, SpecialistsService, WorktimeService, JourneyCore],
})
export class JourneyModule {}
