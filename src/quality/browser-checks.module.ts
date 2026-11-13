import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { BrowserCheckRunner, BrowserChecksService } from './browser-checks.js';
import { BrowserChecksController } from './browser-checks.controller.js';
import { ProjectProfileController, ProjectProfileService } from './project-profile.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [BrowserChecksController, ProjectProfileController], providers: [BrowserCheckRunner, BrowserChecksService, ProjectProfileService] })
export class BrowserChecksModule {}
