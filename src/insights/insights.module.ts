import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

@Module({ imports: [AuthModule], controllers: [InsightsController], providers: [InsightsService] })
export class InsightsModule {}
