import {
  Inject,
  Injectable,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import {
  CREDIT_OPTIONS,
  CREDIT_REDIS_CLIENT,
  CreditBullMqJob,
  CreditBullMqWorker,
  CreditEventStreamClient,
  CreditRedisClient,
  ResolvedCreditOptions,
} from './credit.types';

@Injectable()
export class CreditTransportInfrastructure implements OnApplicationShutdown {
  private streamConnection?: Redis;
  private bullConnection?: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workerClosers = new Set<() => Promise<void>>();

  constructor(
    @Inject(CREDIT_REDIS_CLIENT)
    private readonly operationRedis: CreditRedisClient,
    @Inject(CREDIT_OPTIONS)
    private readonly options: ResolvedCreditOptions,
  ) {}

  streamClient(): CreditEventStreamClient {
    if (!this.streamConnection) {
      this.streamConnection = this.duplicate();
    }
    return this.streamConnection;
  }

  stopStreamReads(): void {
    this.streamConnection?.disconnect();
  }

  async add(
    queueName: string,
    jobName: string,
    data: unknown,
    options: { jobId: string },
  ): Promise<unknown> {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, {
        connection: this.bullMqConnection(),
        prefix: this.transport().prefix,
      });
      this.queues.set(queueName, queue);
    }
    return queue.add(jobName, data, {
      jobId: options.jobId,
      attempts: 10,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  async createWorker(
    queueName: string,
    processor: (job: CreditBullMqJob) => Promise<unknown>,
  ): Promise<CreditBullMqWorker> {
    const worker = new Worker(
      queueName,
      (job) => processor({ id: job.id, name: job.name, data: job.data }),
      {
        connection: this.bullMqConnection(),
        prefix: this.transport().prefix,
      },
    );
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      this.workerClosers.delete(close);
      await worker.close();
    };
    this.workerClosers.add(close);
    return { close };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.workerClosers].map((close) => close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    if (this.bullConnection && this.bullConnection.status !== 'end') {
      await this.bullConnection.quit();
    }
    if (this.streamConnection && this.streamConnection.status !== 'end') {
      await this.streamConnection.quit();
    }
  }

  private bullMqConnection(): Redis {
    if (!this.bullConnection) this.bullConnection = this.duplicate();
    return this.bullConnection;
  }

  private transport() {
    if (!this.options.transport) throw new Error('Credit transport is disabled');
    return this.options.transport;
  }

  private duplicate(): Redis {
    if (typeof this.operationRedis.duplicate !== 'function') {
      throw new TypeError(
        'CREDIT_REDIS_CLIENT must be an ioredis-compatible client with duplicate()',
      );
    }
    return this.operationRedis.duplicate({ maxRetriesPerRequest: null });
  }
}
