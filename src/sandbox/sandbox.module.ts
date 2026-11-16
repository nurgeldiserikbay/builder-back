import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { SandboxRunner, StarterChecksService } from './starter-checks.js';
import { StarterChecksController } from './starter-checks.controller.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [StarterChecksController], providers: [SandboxRunner, StarterChecksService] })
export class SandboxModule {}
