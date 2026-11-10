import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { AccountDeletionController, AdminPrivacyController, LegalController } from './account.controller.js';
import { AccountService } from './account.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule],
  controllers: [LegalController, AccountDeletionController, AdminPrivacyController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
