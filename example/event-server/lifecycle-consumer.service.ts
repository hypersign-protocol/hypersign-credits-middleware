import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  AnyCreditEvent,
  CreditBullMqJob,
  CreditBullMqWorker,
  CreditEventType,
  CreditEventName,
  CreditLifecycleEventEnvelope,
  CreditServiceType,
} from '../../src';
import { ExampleBullMqProvider } from '../bullmq.module';
import { CreditEventStore } from './event-store.service';

@Injectable()
export class CreditLifecycleConsumer
implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditLifecycleConsumer.name);
  private worker?: CreditBullMqWorker;

  constructor(
    private readonly bullMq: ExampleBullMqProvider,
    private readonly store: CreditEventStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.worker = await this.bullMq.createWorker('credit.lifecycle', async (job) => {
      const idempotencyKey = this.validate(job);
      const { existing } = this.store.append(job, idempotencyKey);
      if (existing) return;

      switch (job.name) {
        case CreditEventName.RESERVED:
          this.logger.log(`Credit reserved: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.COMMITTED:
          this.logger.warn(`Credit committed: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.ROLLED_BACK:
          this.logger.log(`Credit rolled back: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.EXPIRED:
          this.logger.log(`Credit expired: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.PLAN_EXPIRED:
          this.logger.log(`Recharge plan expired: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.CREDIT_GRANTED:
          this.logger.log(`Credit granted: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.CRITICAL_BALANCE:
          this.logger.log(`Critical balance reached: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.CREDIT_OBSERVED:
          this.logger.log(`Development usage observed: ${JSON.stringify(job.data)}`);
          break;
        case CreditEventName.COMMAND_REJECTED:
          this.logger.error(`Credit command rejected: ${JSON.stringify(job.data)}`);
          break;
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private validate(job: CreditBullMqJob): string {
    if (job.name === CreditEventName.COMMAND_REJECTED) {
      const rejection = job.data as Record<string, unknown> | undefined;
      if (
        !rejection ||
        rejection.schemaVersion !== 3 ||
        rejection.serviceType !== CreditServiceType.CAVACH_API ||
        typeof rejection.commandId !== 'string' ||
        typeof rejection.reason !== 'string'
      ) {
        throw new Error('Invalid credit command rejection');
      }
      return `command-rejected:${rejection.commandId}`;
    }

    const expectedType = EVENT_TYPES[job.name];
    if (!expectedType) throw new Error(`Unsupported lifecycle job ${job.name}`);

    const envelope = job.data as CreditLifecycleEventEnvelope | undefined;
    const event = envelope?.event as Partial<AnyCreditEvent> | undefined;
    if (
      !envelope ||
      envelope.schemaVersion !== 3 ||
      envelope.serviceType !== CreditServiceType.CAVACH_API ||
      typeof envelope.catalogVersion !== 'string' ||
      !envelope.catalogVersion ||
      typeof envelope.eventId !== 'string' ||
      !envelope.eventId ||
      !event ||
      event.type !== expectedType ||
      typeof event.appId !== 'string' ||
      !event.appId
    ) {
      throw new Error(`Invalid ${job.name} lifecycle envelope`);
    }
    return envelope.eventId;
  }
}

const EVENT_TYPES: Record<string, AnyCreditEvent['type']> = {
  [CreditEventName.RESERVED]: CreditEventType.RESERVED,
  [CreditEventName.COMMITTED]: CreditEventType.COMMITTED,
  [CreditEventName.ROLLED_BACK]: CreditEventType.ROLLED_BACK,
  [CreditEventName.EXPIRED]: CreditEventType.EXPIRED,
  [CreditEventName.PLAN_EXPIRED]: CreditEventType.PLAN_EXPIRED,
  [CreditEventName.CREDIT_GRANTED]: CreditEventType.CREDIT_GRANTED,
  [CreditEventName.CRITICAL_BALANCE]: CreditEventType.CRITICAL_BALANCE,
  [CreditEventName.CREDIT_OBSERVED]: CreditEventType.CREDIT_OBSERVED,
};
