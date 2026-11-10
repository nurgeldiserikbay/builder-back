import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { AdminBillingModeController, PaymentsCallbackController, ProjectWalletController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule, JourneyModule],
  controllers: [ProjectWalletController, PaymentsCallbackController, AdminBillingModeController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
