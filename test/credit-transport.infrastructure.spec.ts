import { Queue, Worker } from 'bullmq';
import { CreditTransportInfrastructure } from '../src/credit-transport.infrastructure';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';

jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(),
}));

describe('CreditTransportInfrastructure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('duplicates the host Redis client and owns queue job policy', async () => {
    const stream = connection();
    const bull = connection();
    const redis = {
      eval: jest.fn(),
      duplicate: jest.fn().mockReturnValueOnce(stream).mockReturnValueOnce(bull),
    };
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    (Queue as unknown as jest.Mock).mockImplementation(() => ({
      add,
      close: jest.fn(),
    }));
    const infrastructure = createInfrastructure(redis);

    expect(infrastructure.streamClient()).toBe(stream);
    await infrastructure.add('credit.lifecycle', 'credit.committed', { ok: true }, {
      jobId: 'event-1',
    });

    expect(redis.duplicate).toHaveBeenNthCalledWith(1, {
      maxRetriesPerRequest: null,
    });
    expect(redis.duplicate).toHaveBeenNthCalledWith(2, {
      maxRetriesPerRequest: null,
    });
    expect(Queue).toHaveBeenCalledWith('credit.lifecycle', {
      connection: bull,
      prefix: 'bull',
    });
    expect(add).toHaveBeenCalledWith('credit.committed', { ok: true }, {
      jobId: 'event-1',
      attempts: 10,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  });

  it('closes only SDK-owned connections and makes worker close idempotent', async () => {
    const bull = connection();
    const redis = { eval: jest.fn(), duplicate: jest.fn().mockReturnValue(bull) };
    const closeWorker = jest.fn().mockResolvedValue(undefined);
    (Worker as unknown as jest.Mock).mockImplementation(() => ({ close: closeWorker }));
    const infrastructure = createInfrastructure(redis);
    const worker = await infrastructure.createWorker('credit.commands.kyc', jest.fn());

    await worker.close();
    await worker.close();
    await infrastructure.onApplicationShutdown();

    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(bull.quit).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('fails clearly when the supplied Redis client cannot be duplicated', () => {
    const infrastructure = createInfrastructure({ eval: jest.fn() });
    expect(() => infrastructure.streamClient()).toThrow(
      'CREDIT_REDIS_CLIENT must be an ioredis-compatible client with duplicate()',
    );
  });
});

function connection() {
  return {
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

function createInfrastructure(redis: any): CreditTransportInfrastructure {
  return new CreditTransportInfrastructure(redis, DEFAULT_CREDIT_OPTIONS);
}
