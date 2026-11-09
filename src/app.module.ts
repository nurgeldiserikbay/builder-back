import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { CapabilitiesModule } from './capabilities/capabilities.module.js';
import { StaffAuthModule } from './admin/staff-auth.module.js';
import { JourneyModule } from './journey/journey.module.js';
import { PublishingModule } from './publishing/publishing.module.js';
import { BillingModule } from './billing/billing.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, ProjectsModule, ReviewsModule, CapabilitiesModule, StaffAuthModule, JourneyModule, PublishingModule, BillingModule],
  controllers: [HealthController, WorkspacesController],
})
export class AppModule {}
