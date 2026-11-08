import { Module } from '@nestjs/common';
import { CapabilitiesController } from './capabilities.controller.js';

@Module({
  controllers: [CapabilitiesController],
})
export class CapabilitiesModule {}
