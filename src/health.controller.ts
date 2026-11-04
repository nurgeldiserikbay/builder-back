import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { data: { status: 'ok'; timestamp: string } } {
    return { data: { status: 'ok', timestamp: new Date().toISOString() } };
  }
}
