import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';
import { ReviewsCore } from './reviews-core.js';
import { ReviewDesignsService } from './review-designs.service.js';
import { ReviewFigmaService } from './review-figma.service.js';
import { ReviewCapturesService } from './review-captures.service.js';
import { ReviewChecksService } from './review-checks.service.js';
import { ReviewReportService } from './review-report.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ReviewsController],
  providers: [ReviewsCore, ReviewDesignsService, ReviewFigmaService, ReviewCapturesService, ReviewChecksService, ReviewReportService, ReviewsService],
})
export class ReviewsModule {}
