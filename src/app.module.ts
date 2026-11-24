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
import { ImagesModule } from './images/images.module.js';
import { BillingModule } from './billing/billing.module.js';
import { AccountModule } from './account/account.module.js';
import { ChoicesModule } from './choices/choices.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { BudgetModule } from './budget/budget.module.js';
import { DisputesModule } from './disputes/disputes.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { MonitoringModule } from './monitoring/monitoring.module.js';
import { TeamModule } from './team/team.module.js';
import { InboxModule } from './inbox/inbox.module.js';
import { WorkModule } from './work/work.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { BrowserChecksModule } from './quality/browser-checks.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, ProjectsModule, ReviewsModule, CapabilitiesModule, StaffAuthModule, JourneyModule, PublishingModule, BillingModule, ImagesModule, AccountModule, ChoicesModule, BudgetModule, PaymentsModule, DisputesModule, CatalogModule, InsightsModule, MonitoringModule, TeamModule, InboxModule, WorkModule, AnalysisModule, BrowserChecksModule, SandboxModule],
  controllers: [HealthController, WorkspacesController],
})
export class AppModule {}
