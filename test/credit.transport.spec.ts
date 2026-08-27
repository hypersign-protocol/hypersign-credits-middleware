import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditEventName,
  CreditEventType,
} from '../src/credit.enums';
import { CreditCommandWorker, CreditEventRelay } from '../src/credit.transport';

const createTransport = () => {
  const provider = { add: jest.fn(), createWorker: jest.fn() };
  const streamClient = {
    xgroup: jest.fn(), xreadgroup: jest.fn(), xautoclaim: jest.fn(), xack: jest.fn(),
  };
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: { serviceType: 'kyc', version: '7', routes: [] },
    transport: {
      prefix: 'bull',
      lifecycleQueueNames: ['credit.lifecycle', 'credit.audit'],
      commandQueueName: 'credit.commands.kyc',
      consumerGroup: 'relay:kyc',
      batchSize: 100,
      blockMs: 5_000,
      pendingIdleMs: 30_000,
    },
  };
  const infrastructure = {
    ...provider,
    streamClient: jest.fn(() => streamClient),
    stopStreamReads: jest.fn(),
  };
  return { provider, streamClient, infrastructure, options };
};

describe('CreditEventRelay', () => {
  it('publishes every destination before acknowledging the Stream event', async () => {
    const { provider, streamClient, infrastructure, options } = createTransport();
    provider.add.mockResolvedValue({});
    const catalog = new CreditCatalogService(options);
    const relay = new CreditEventRelay(options, catalog, infrastructure as any);

    await (relay as any).publishEntries([[
      '1234-0',
      ['event', CreditEventType.COMMITTED, 'timestamp', '1234', 'serviceType', 'kyc',
        'appId', 'a1', 'creditType', 'API', 'amount', '4',
        'balanceAfter', '96', 'reservationId', 'r1'],
    ]]);

    expect(provider.add).toHaveBeenCalledTimes(2);
    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle',
      CreditEventName.COMMITTED,
      expect.objectContaining({
        eventId: '1234-0', schemaVersion: 3, catalogVersion: '7',
        event: expect.objectContaining({ amount: 4, balanceAfter: 96 }),
      }),
      { jobId: 'kyc-1234-0' },
    );
    expect(streamClient.xack).toHaveBeenCalledWith(
      DEFAULT_CREDIT_OPTIONS.eventStreamKey, 'relay:kyc', '1234-0',
    );
    expect(provider.add.mock.invocationCallOrder[1])
      .toBeLessThan(streamClient.xack.mock.invocationCallOrder[0]);
  });

  it('keeps the catalog version captured when the event was created', async () => {
    const { provider, infrastructure, options } = createTransport();
    provider.add.mockResolvedValue({});
    const relay = new CreditEventRelay(
      options, new CreditCatalogService(options), infrastructure as any,
    );

    await (relay as any).publishEntries([[
      '1235-0',
      ['event', CreditEventType.COMMITTED, 'serviceType', 'kyc',
        'catalogVersion', '6'],
    ]]);

    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle', CreditEventName.COMMITTED,
      expect.objectContaining({
        catalogVersion: '6',
        event: expect.not.objectContaining({ catalogVersion: expect.anything() }),
      }),
      { jobId: 'kyc-1235-0' },
    );
  });

  it('does not acknowledge an event when BullMQ publishing fails', async () => {
    const { provider, streamClient, infrastructure, options } = createTransport();
    provider.add.mockRejectedValue(new Error('queue unavailable'));
    const relay = new CreditEventRelay(
      options, new CreditCatalogService(options), infrastructure as any,
    );
    await expect((relay as any).publishEntries([[
      '1234-0', ['event', CreditEventType.RESERVED, 'serviceType', 'kyc'],
    ]])).rejects.toThrow('queue unavailable');
    expect(streamClient.xack).not.toHaveBeenCalled();
  });

  it('relays dev observations with numeric zero deduction and explicit mode', async () => {
    const { provider, infrastructure, options } = createTransport();
    provider.add.mockResolvedValue({});
    const relay = new CreditEventRelay(
      options, new CreditCatalogService(options), infrastructure as any,
    );

    await (relay as any).publishEntries([[
      '2000-0',
      ['event', CreditEventType.CREDIT_OBSERVED,
        'timestamp', '2000', 'serviceType', 'kyc',
        'scopeId', 'scope-a1', 'appId', 'a1', 'creditType', 'API',
        'requestId', 'request-dev:api', 'operation', 'POST /submit',
        'requestedAmount', '5', 'deductedAmount', '0',
        'environment', CreditEnvironment.DEV,
        'billingMode', CreditBillingMode.OBSERVE],
    ]]);

    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle',
      CreditEventName.CREDIT_OBSERVED,
      expect.objectContaining({
        schemaVersion: 3,
        serviceType: 'kyc',
        event: expect.objectContaining({
          type: CreditEventType.CREDIT_OBSERVED,
          requestedAmount: 5,
          deductedAmount: 0,
          environment: CreditEnvironment.DEV,
          billingMode: CreditBillingMode.OBSERVE,
        }),
      }),
      { jobId: 'kyc-2000-0' },
    );
  });

  it('recreates a consumer group lost during a Redis restart', async () => {
    const { streamClient, infrastructure, options } = createTransport();
    const relay = new CreditEventRelay(
      options, new CreditCatalogService(options), infrastructure as any,
    );
    streamClient.xgroup.mockResolvedValue('OK');
    streamClient.xautoclaim
      .mockRejectedValueOnce(new Error('NOGROUP No such key or consumer group'))
      .mockResolvedValueOnce(['0-0', []]);
    streamClient.xreadgroup.mockImplementation(async () => {
      (relay as any).running = false;
      return null;
    });
    (relay as any).running = true;

    await (relay as any).run();

    expect(streamClient.xgroup).toHaveBeenCalledWith(
      'CREATE', options.eventStreamKey, options.transport.consumerGroup, '0', 'MKSTREAM',
    );
    expect(streamClient.xautoclaim).toHaveBeenCalledTimes(2);
  });

  it('retries a transient relay failure instead of stopping permanently', async () => {
    const { streamClient, infrastructure, options } = createTransport();
    options.transport.blockMs = 1;
    const relay = new CreditEventRelay(
      options, new CreditCatalogService(options), infrastructure as any,
    );
    streamClient.xautoclaim
      .mockRejectedValueOnce(new Error('temporary Redis failure'))
      .mockImplementationOnce(async () => {
        (relay as any).running = false;
        return ['0-0', []];
      });
    (relay as any).running = true;

    await (relay as any).run();

    expect(streamClient.xautoclaim).toHaveBeenCalledTimes(2);
  });
});

describe('CreditCommandWorker', () => {
  it('executes a trusted idempotent grant command', async () => {
    const { provider, infrastructure, options } = createTransport();
    const credits = { grant: jest.fn().mockResolvedValue({ balance: 50, existing: false }) };
    const worker = new CreditCommandWorker(
      options,
      new CreditCatalogService(options),
      credits as any,
      infrastructure as any,
    );

    await expect((worker as any).process({
      id: 'command-1',
      name: 'credit.grant.requested',
      data: {
        commandId: 'command-1', schemaVersion: 3, serviceType: 'kyc',
        payload: {
          subject: { appId: 'account-1', creditType: 'API' },
          amount: 50,
          criticalBalance: 10,
          planId: 'plan-1',
          grantedAt: 1_000,
          expiresAt: 2_000,
          referenceId: 'payment-1',
        },
      },
    })).resolves.toEqual({ balance: 50, existing: false });

    expect(credits.grant).toHaveBeenCalledWith({
      subject: {
        appId: 'account-1', creditType: 'API',
        tenantId: undefined, appType: undefined,
      },
      amount: 50,
      criticalBalance: 10,
      planId: 'plan-1',
      grantedAt: 1_000,
      expiresAt: 2_000,
      referenceId: 'payment-1',
      reason: undefined,
    });
    expect(provider.add).not.toHaveBeenCalled();
  });

  it('publishes a command rejection to every lifecycle destination', async () => {
    const { provider, infrastructure, options } = createTransport();
    provider.add.mockResolvedValue({});
    const worker = new CreditCommandWorker(
      options,
      new CreditCatalogService(options),
      { grant: jest.fn() } as any,
      infrastructure as any,
    );
    await expect((worker as any).process({
      id: 'bad-command',
      name: 'credit.grant.requested',
      data: {
        commandId: 'bad-command', schemaVersion: 3, serviceType: 'kyc',
        payload: {
          subject: { appId: 'a', creditType: 'API' }, amount: -1,
          planId: 'plan-bad', grantedAt: 1_000, expiresAt: 2_000,
        },
      },
    })).rejects.toThrow('positive safe integer');
    expect(provider.add).toHaveBeenCalledTimes(2);
    expect(provider.add).toHaveBeenCalledWith(
      'credit.lifecycle', 'credit.command-rejected',
      expect.objectContaining({ commandId: 'bad-command' }),
      { jobId: 'kyc-bad-command-rejected' },
    );
  });
});
