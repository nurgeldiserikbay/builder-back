import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { AdminPlansController, BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Global()
@Module({
  imports: [AuthModule, StaffAuthModule],
  controllers: [BillingController, AdminPlansController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
