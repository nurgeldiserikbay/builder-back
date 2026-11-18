import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { ChoicesController, GitAccountsController, GithubOauthController } from './choices.controller.js';
import { ChoicesService } from './choices.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [ChoicesController, GithubOauthController, GitAccountsController],
  providers: [ChoicesService],
  exports: [ChoicesService],
})
export class ChoicesModule {}
