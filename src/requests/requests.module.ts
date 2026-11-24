import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({ imports: [AuthModule, BillingModule, JourneyModule], controllers: [RequestsController], providers: [RequestsService] })
export class RequestsModule {}
