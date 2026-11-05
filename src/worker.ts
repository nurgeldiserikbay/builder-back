import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ReviewWorker } from './reviews/review-worker.js';
import { ReviewWorkerModule } from './reviews/review-worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ReviewWorkerModule, { bufferLogs: true });
  app.enableShutdownHooks();
  await app.get(ReviewWorker).run();
  await app.close();
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message + '\n' : 'WORKER_START_FAILED\n');
  process.exitCode = 1;
});
