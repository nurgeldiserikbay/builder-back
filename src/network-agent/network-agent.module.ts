import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JourneyModule } from '../journey/journey.module.js';
import { NetworkAgentController, NetworkAgentGatewayController } from './network-agent.controller.js';
import { NetworkAgentService } from './network-agent.service.js';

@Module({
  imports: [AuthModule, JourneyModule],
  controllers: [NetworkAgentController, NetworkAgentGatewayController],
  providers: [NetworkAgentService],
})
export class NetworkAgentModule {}
