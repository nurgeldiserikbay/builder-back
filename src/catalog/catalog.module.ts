import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminReviewsController, AdminSpecialistReportsController, CatalogController } from './catalog.controller.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule],
  controllers: [CatalogController, AdminReviewsController, AdminSpecialistReportsController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
