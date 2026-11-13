import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisRunner } from './analysis-runner.js';
import { AnalysisService } from './analysis.service.js';
import { StageFilesService } from './stage-files.service.js';

@Module({ imports: [AuthModule, JourneyModule], controllers: [AnalysisController], providers: [StageFilesService, AnalysisService, AnalysisRunner] })
export class AnalysisModule {}
