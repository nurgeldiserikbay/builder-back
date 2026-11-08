import { Controller, Get, Header } from '@nestjs/common';
import { capabilityManifest } from './capability-manifest.js';

@Controller('capabilities')
export class CapabilitiesController {
  @Get()
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  getCatalog() {
    return { data: capabilityManifest };
  }
}
