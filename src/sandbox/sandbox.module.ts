import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { SandboxRunner, StarterChecksService } from './starter-checks.js';
import { AppCodeController, StarterChecksController } from './starter-checks.controller.js';
import { AppCodeService } from './app-code.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [StarterChecksController, AppCodeController], providers: [SandboxRunner, StarterChecksService, AppCodeService] })
export class SandboxModule {}
