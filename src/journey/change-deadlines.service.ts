import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JourneyService } from './journey.service.js';

const INTERVAL_MS = 15 * 60_000;
/** Only one API instance sends reminders at a time. */
const LOCK_KEY = 7_316_003;

@Injectable()
export class ChangeDeadlinesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ChangeDeadlines');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService) {}

  onApplicationBootstrap(): void {
    if (process.env.CHANGE_REMINDERS_DISABLED === 'true') return;
    const run = () => { this.tick().catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'CHANGE_DEADLINES_FAILED')); };
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref();
    setTimeout(run, 60_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    const locked = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked[0]?.locked) return { reminded: 0, escalated: 0 };
    try {
      const result = await this.journey.processChangeDeadlines(now);
      if (result.reminded || result.escalated) this.logger.log(`reminded ${result.reminded}, escalated ${result.escalated}`);
      return result;
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  }
}
