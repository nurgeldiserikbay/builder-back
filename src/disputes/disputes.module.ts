import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { AdminDisputesController, DisputesController } from './disputes.controller.js';
import { DisputesService } from './disputes.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule],
  controllers: [DisputesController, AdminDisputesController],
  providers: [DisputesService],
})
export class DisputesModule {}
