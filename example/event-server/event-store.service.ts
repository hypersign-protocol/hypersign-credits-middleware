import { Injectable } from '@nestjs/common';
import { CreditBullMqJob } from '../../src';

export interface StoredCreditEvent {
  idempotencyKey: string;
  receivedAt: string;
  jobId?: string;
  name: string;
  data: unknown;
}

/**
 * Demo persistence boundary. Replace this bounded memory store with a
 * TimescaleDB repository without changing the BullMQ consumer.
 */
@Injectable()
export class CreditEventStore {
  private readonly events: StoredCreditEvent[] = [];
  private readonly eventsById = new Map<string, StoredCreditEvent>();

  append(
    job: CreditBullMqJob,
    idempotencyKey: string,
  ): { event: StoredCreditEvent; existing: boolean } {
    const existing = this.eventsById.get(idempotencyKey);
    if (existing) return { event: existing, existing: true };

    const event = {
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      jobId: job.id,
      name: job.name,
      data: job.data,
    };
    this.eventsById.set(idempotencyKey, event);
    this.events.unshift(event);
    for (const removed of this.events.splice(1_000)) {
      this.eventsById.delete(removed.idempotencyKey);
    }
    return { event, existing: false };
  }

  recent(limit: number): StoredCreditEvent[] {
    return this.events.slice(0, limit);
  }
}
