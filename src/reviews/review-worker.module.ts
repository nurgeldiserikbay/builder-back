import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ReviewWorker } from './review-worker.js';

@Module({
  imports: [DatabaseModule],
  providers: [ReviewWorker],
  exports: [ReviewWorker],
})
export class ReviewWorkerModule {}
