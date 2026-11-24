import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WorkController } from './work.controller.js';
import { WorkService } from './work.service.js';

@Module({ imports: [AuthModule], controllers: [WorkController], providers: [WorkService] })
export class WorkModule {}
