import { Module } from '@nestjs/common';
import { ChoicesModule } from '../choices/choices.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { SandboxRunner, StarterChecksService } from './starter-checks.js';
import { AppCodeController, StarterChecksController } from './starter-checks.controller.js';
import { AppCodeService } from './app-code.js';
import { AgentController } from '../agent/agent.controller.js';
import { AgentRunner, AgentTasksService } from '../agent/agent-tasks.js';

@Module({ imports: [AuthModule, JourneyModule, ChoicesModule], controllers: [StarterChecksController, AppCodeController, AgentController], providers: [SandboxRunner, StarterChecksService, AppCodeService, AgentRunner, AgentTasksService] })
export class SandboxModule {}
