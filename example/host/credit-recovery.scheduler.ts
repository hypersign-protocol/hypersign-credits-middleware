import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CreditRecoveryService } from '../../src';

@Injectable()
export class CreditRecoveryScheduler {
  constructor(private readonly recovery: CreditRecoveryService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'credit-recovery',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    await this.recovery.runOnce();
  }
}
