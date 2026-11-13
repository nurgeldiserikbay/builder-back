import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ReviewWorker } from './review-worker.js';
import { AnalysisRunner } from '../analysis/analysis-runner.js';
import { BrowserCheckRunner } from '../quality/browser-checks.js';

@Module({
  imports: [DatabaseModule],
  providers: [ReviewWorker, AnalysisRunner, BrowserCheckRunner],
  exports: [ReviewWorker, AnalysisRunner, BrowserCheckRunner],
})
export class ReviewWorkerModule {}
