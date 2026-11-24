import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { AdminAiPricingController, ProjectBudgetController, RouteEstimateController } from './budget.controller.js';
import { BudgetService } from './budget.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule, JourneyModule],
  controllers: [ProjectBudgetController, RouteEstimateController, AdminAiPricingController],
  providers: [BudgetService],
})
export class BudgetModule {}
