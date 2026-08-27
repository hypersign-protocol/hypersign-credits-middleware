import { Injectable, Logger } from '@nestjs/common';
import { CreditService } from './credit.service';

/**
 * Stateless recovery entry point. The library intentionally does not schedule
 * this method; invoke it from a dedicated worker, cron job, or external
 * scheduler so recovery continues when API instances are unavailable.
 *
 * Each successful recovery writes its durable `EXPIRED` event atomically in Redis;
 * the SDK event relay forwards it to BullMQ.
 */
@Injectable()
export class CreditRecoveryService {
  private readonly logger = new Logger(CreditRecoveryService.name);
  private running = false;

  constructor(
    private readonly credits: CreditService,
  ) {}

  async runOnce(): Promise<number> {
    // Prevent overlapping passes within one worker process. Redis Lua still
    // guarantees correctness when several different workers run concurrently.
    if (this.running) return 0;
    this.running = true;
    try {
      const [reservations, plans] = await Promise.all([
        this.credits.recoverExpired(),
        this.credits.recoverExpiredPlans(),
      ]);
      if (reservations.length > 0) {
        this.logger.warn(
          `Recovered ${reservations.length} expired credit reservation(s)`,
        );
      }
      if (plans.length > 0) {
        this.logger.log(`Expired ${plans.length} recharge plan(s)`);
      }
      return reservations.length + plans.length;
    } catch (error) {
      this.logger.error('Credit reservation recovery failed', error);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
