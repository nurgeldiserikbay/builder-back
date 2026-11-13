import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { BrowserCheckRunner, BrowserChecksService } from './browser-checks.js';
import { BrowserChecksController } from './browser-checks.controller.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [BrowserChecksController], providers: [BrowserCheckRunner, BrowserChecksService] })
export class BrowserChecksModule {}
