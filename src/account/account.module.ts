import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthModule } from '../admin/staff-auth.module.js';
import { AccountDeletionController, AdminPrivacyController, LegalController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';

@Module({
  imports: [AuthModule, StaffAuthModule],
  controllers: [LegalController, AccountDeletionController, AdminPrivacyController, SecurityController],
  providers: [AccountService, SecurityService],
  exports: [AccountService],
})
export class AccountModule {}
