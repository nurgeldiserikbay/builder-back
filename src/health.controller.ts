import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './database/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  getHealth(): { data: { status: 'ok'; timestamp: string } } {
    return { data: { status: 'ok', timestamp: new Date().toISOString() } };
  }

  @Get('ready')
  async getReadiness(): Promise<{ data: { status: 'ready'; database: 'ok'; timestamp: string } }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        data: {
          status: 'not_ready',
          database: 'unavailable',
          timestamp: new Date().toISOString(),
        },
      });
    }

    return {
      data: {
        status: 'ready',
        database: 'ok',
        timestamp: new Date().toISOString(),
      },
    };
  }
}
