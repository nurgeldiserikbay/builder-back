import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InviteInfoController, JourneyController } from './journey.controller.js';
import { SpecialistsService } from './specialists.service.js';
import { JourneyService } from './journey.service.js';
import { JourneyCore } from './journey-core.js';
import { InterviewService } from './interview.service.js';
import { StageAiService } from './stage-ai.service.js';
import { ChangeNoticesService } from './change-notices.service.js';
import { WorktimeService } from './worktime.service.js';
import { ChangeDeadlinesService } from './change-deadlines.service.js';
import { CommentsService } from './comments.service.js';
import { StageReviewService } from './stage-review.service.js';
import { ChangeProposalsService } from './change-proposals.service.js';
import { PlaybooksService } from './playbooks.service.js';

@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [JourneyController, InviteInfoController],
  providers: [JourneyCore, StageAiService, InterviewService, ChangeNoticesService, JourneyService, SpecialistsService, WorktimeService, ChangeDeadlinesService, CommentsService, StageReviewService, ChangeProposalsService, PlaybooksService],
  exports: [JourneyService, SpecialistsService, WorktimeService, JourneyCore, CommentsService, StageReviewService, InterviewService],
})
export class JourneyModule {}
