import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';

@Module({ imports: [AuthModule], controllers: [MonitoringController], providers: [MonitoringService] })
export class MonitoringModule {}
