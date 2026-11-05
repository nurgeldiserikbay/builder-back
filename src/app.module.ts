import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { ReviewsModule } from './reviews/reviews.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, ProjectsModule, ReviewsModule],
  controllers: [HealthController, WorkspacesController],
})
export class AppModule {}
