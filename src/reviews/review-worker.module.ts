import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ReviewWorker } from './review-worker.js';
import { AnalysisRunner } from '../analysis/analysis-runner.js';

@Module({
  imports: [DatabaseModule],
  providers: [ReviewWorker, AnalysisRunner],
  exports: [ReviewWorker, AnalysisRunner],
})
export class ReviewWorkerModule {}
