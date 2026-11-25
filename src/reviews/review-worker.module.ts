import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ReviewWorker } from './review-worker.js';
import { AnalysisRunner } from '../analysis/analysis-runner.js';
import { BrowserCheckRunner } from '../quality/browser-checks.js';
import { SandboxRunner } from '../sandbox/starter-checks.js';
import { AgentRunner } from '../agent/agent-tasks.js';
import { BrowserCaseRunner } from '../agent/browser-case-runs.js';

@Module({
  imports: [DatabaseModule],
  providers: [ReviewWorker, AnalysisRunner, BrowserCheckRunner, SandboxRunner, AgentRunner, BrowserCaseRunner],
  exports: [ReviewWorker, AnalysisRunner, BrowserCheckRunner, SandboxRunner, AgentRunner, BrowserCaseRunner],
})
export class ReviewWorkerModule {}
