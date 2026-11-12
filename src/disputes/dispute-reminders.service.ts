import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { DisputesService } from './disputes.service.js';

const INTERVAL_MS = 60 * 60_000;
/** Only one API instance sends reminders at a time. */
const LOCK_KEY = 7_316_004;

/** Hourly: one reminder to the side of a dispute that has not answered for 3 days. */
@Injectable()
export class DisputeRemindersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('DisputeReminders');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly disputes: DisputesService) {}

  onApplicationBootstrap(): void {
    if (process.env.DISPUTE_REMINDERS_DISABLED === 'true') return;
    const run = () => { this.tick().catch((error: unknown) => this.logger.error(error instanceof Error ? error.message : 'DISPUTE_REMINDERS_FAILED')); };
    this.timer = setInterval(run, INTERVAL_MS);
    this.timer.unref();
    setTimeout(run, 90_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    const locked = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked[0]?.locked) return 0;
    try {
      const sent = await this.disputes.processReminders(now);
      if (sent) this.logger.log(`reminded ${sent}`);
      return sent;
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  }
}
