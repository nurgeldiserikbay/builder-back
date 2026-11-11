import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { AdminBillingModeController, AdminPayoutsController, AdminRefundsController, PaymentsCallbackController, ProjectWalletController, SpecialistPaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule, JourneyModule],
  controllers: [ProjectWalletController, PaymentsCallbackController, AdminBillingModeController, SpecialistPaymentsController, AdminPayoutsController, AdminRefundsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
