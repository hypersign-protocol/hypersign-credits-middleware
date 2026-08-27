import {
  CreditAppType,
  CreditBullMqJob,
  CreditEventType,
  CreditEventName,
  CreditServiceType,
  CreditType,
} from '../src';
import { ExampleBullMqProvider } from '../example/bullmq.module';
import { CreditEventsController } from '../example/event-server/credit-events.controller';
import { CreditEventStore } from '../example/event-server/event-store.service';
import { CreditLifecycleConsumer } from '../example/event-server/lifecycle-consumer.service';

describe('repository event-server example', () => {
  it('generates internal grant fields and calculates the 40% threshold', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const controller = new CreditEventsController(
      { add } as unknown as ExampleBullMqProvider,
      new CreditEventStore(),
    );

    const result = await controller.grant({
      tenantId: 'tenant/acme',
      appId: 'app:123',
      planId: 'api-plan-001',
      amount: 1_000,
      grantedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });

    expect(result).toEqual({
      queued: true,
      commandId: 'grant-CAVACH_API-api-plan-001',
      queue: 'credit.commands.CAVACH_API',
      planId: 'api-plan-001',
      referenceId: 'example-grant-api-plan-001',
    });
    expect(add).toHaveBeenCalledWith(
      'credit.commands.CAVACH_API',
      CreditEventName.GRANT_REQUESTED,
      expect.objectContaining({
        schemaVersion: 3,
        commandId: 'grant-CAVACH_API-api-plan-001',
        serviceType: CreditServiceType.CAVACH_API,
        payload: expect.objectContaining({
          subject: {
            tenantId: 'tenant/acme',
            appId: 'app:123',
            appType: CreditAppType.CAVACH_API,
            creditType: CreditType.API_CREDIT,
          },
          amount: 1_000,
          criticalBalance: 400,
          planId: 'api-plan-001',
          referenceId: 'example-grant-api-plan-001',
        }),
      }),
      { jobId: 'grant-CAVACH_API-api-plan-001' },
    );
  });

  it('validates and deduplicates lifecycle envelopes by eventId', async () => {
    let processor: ((job: CreditBullMqJob) => Promise<unknown>) | undefined;
    const close = jest.fn().mockResolvedValue(undefined);
    const provider = {
      createWorker: jest.fn().mockImplementation((_queue, handler) => {
        processor = handler;
        return Promise.resolve({ close });
      }),
    } as unknown as ExampleBullMqProvider;
    const store = new CreditEventStore();
    const consumer = new CreditLifecycleConsumer(provider, store);
    await consumer.onApplicationBootstrap();

    const job: CreditBullMqJob = {
      id: 'CAVACH_API-1-0',
      name: CreditEventName.CREDIT_GRANTED,
      data: {
        schemaVersion: 3,
        serviceType: CreditServiceType.CAVACH_API,
        catalogVersion: '3.21.1',
        eventId: '1-0',
        event: { type: CreditEventType.CREDIT_GRANTED, appId: 'app:123' },
      },
    };
    await processor!(job);
    await processor!(job);

    expect(store.recent(10)).toHaveLength(1);
    expect(store.recent(10)[0].idempotencyKey).toBe('1-0');
    await consumer.onApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
