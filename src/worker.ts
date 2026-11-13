import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ReviewWorker } from './reviews/review-worker.js';
import { ReviewWorkerModule } from './reviews/review-worker.module.js';
import { AnalysisRunner } from './analysis/analysis-runner.js';
import { BrowserCheckRunner } from './quality/browser-checks.js';
import { flushErrorReporting, initErrorReporting, reportError } from './observability/error-reporting.js';

initErrorReporting('worker');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ReviewWorkerModule, { bufferLogs: true });
  app.enableShutdownHooks();
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  // Review pages, code analysis and browser checks share the process; each loop claims its own jobs.
  await Promise.all([app.get(ReviewWorker).run(), app.get(AnalysisRunner).loop(() => stopping), app.get(BrowserCheckRunner).loop(() => stopping)]);
  await app.close();
}

void bootstrap().catch(async (error: unknown) => {
  reportError(error);
  await flushErrorReporting();
  process.stderr.write(error instanceof Error ? error.message + '\n' : 'WORKER_START_FAILED\n');
  process.exitCode = 1;
});
