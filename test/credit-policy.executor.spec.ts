import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditSettlementMode,
} from '../src/credit.enums';
import { CreditPolicyExecutor } from '../src/credit-policy.executor';

describe('CreditPolicyExecutor', () => {
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: {
      serviceType: 'kyc', version: '1', routes: [{
        method: 'POST', path: '/submit', charges: [
          { id: 'api', creditType: 'API', amount: 5 },
          {
            id: 'txn', creditType: 'TXN', amount: 25,
            settlementMode: CreditSettlementMode.DEFERRED,
            autoRecover: false,
          },
        ],
      }],
    },
  };
  const catalog = new CreditCatalogService(options);
  const route = catalog.find('POST', '/submit')!;
  const result = (id: string, creditType: string) => ({
    reservationId: id,
    leaseToken: `lease-${id}`,
    scopeId: `scope-${id}`,
    remainingBalance: 50,
    expiresAt: 1_000,
    autoRecover: creditType === 'API',
    environment: CreditEnvironment.PROD,
    billingMode: CreditBillingMode.ENFORCE,
    existing: false,
    settlementMode: creditType === 'API'
      ? CreditSettlementMode.IMMEDIATE
      : CreditSettlementMode.DEFERRED,
    subject: { appId: 'account', creditType },
    allocations: [{ planId: `${creditType}-plan`, amount: 5, planBalanceAfter: 45 }],
  });

  it('creates independent prod reservations with scoped request IDs', async () => {
    const credits = { reserve: jest.fn(), observe: jest.fn(), rollback: jest.fn() };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockResolvedValueOnce(result('txn-res', 'TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    const applied = await executor.apply(route, {
      subject: { appId: 'account' },
      requestId: 'request-1',
      environment: CreditEnvironment.PROD,
    });

    expect(applied.map((value) => value.billingMode === CreditBillingMode.ENFORCE
      ? value.reservation.reservationId : 'unexpected'))
      .toEqual(['api-res', 'txn-res']);
    expect(credits.reserve).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'request-1:api',
      subject: { appId: 'account', creditType: 'API' },
      environment: CreditEnvironment.PROD,
    }));
    expect(credits.reserve).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'request-1:txn',
      settlementMode: CreditSettlementMode.DEFERRED,
      autoRecover: false,
    }));
    expect(credits.observe).not.toHaveBeenCalled();
  });

  it('compensates an earlier reservation when a later charge fails', async () => {
    const credits = { reserve: jest.fn(), rollback: jest.fn().mockResolvedValue(true) };
    credits.reserve
      .mockResolvedValueOnce(result('api-res', 'API'))
      .mockRejectedValueOnce(new Error('insufficient TXN'));
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    await expect(executor.apply(route, {
      subject: { appId: 'account' },
      requestId: 'request-1',
      environment: CreditEnvironment.PROD,
    })).rejects.toThrow('insufficient TXN');
    expect(credits.rollback).toHaveBeenCalledWith(
      'api-res', 'catalog_reservation_failed',
    );
  });

  it('records dev observations without reserving, checking, or rolling back credit', async () => {
    const credits = {
      reserve: jest.fn(), rollback: jest.fn(),
      observe: jest.fn()
        .mockResolvedValueOnce(observation('api-event', 'API', 5))
        .mockResolvedValueOnce(observation('txn-event', 'TXN', 25)),
    };
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    const applied = await executor.apply(route, {
      subject: { appId: 'account' },
      requestId: 'request-dev',
      environment: CreditEnvironment.DEV,
    });

    expect(applied.map((value) => value.billingMode)).toEqual([
      CreditBillingMode.OBSERVE,
      CreditBillingMode.OBSERVE,
    ]);
    expect(credits.observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'request-dev:api',
      amount: 5,
      environment: CreditEnvironment.DEV,
      subject: { appId: 'account', creditType: 'API' },
    }));
    expect(credits.observe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'request-dev:txn',
      amount: 25,
      environment: CreditEnvironment.DEV,
      subject: { appId: 'account', creditType: 'TXN' },
    }));
    expect(credits.reserve).not.toHaveBeenCalled();
    await executor.rollbackAll(applied, 'controller failed');
    expect(credits.rollback).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted environment is missing or invalid', async () => {
    const credits = { reserve: jest.fn(), observe: jest.fn() };
    const executor = new CreditPolicyExecutor(credits as any, catalog);

    await expect(executor.apply(route, {
      subject: { appId: 'account' }, environment: undefined as any,
    })).rejects.toThrow('A trusted billing environment is required');
    await expect(executor.apply(route, {
      subject: { appId: 'account' }, environment: 'STAGING' as any,
    })).rejects.toThrow('Billing environment must be prod or dev');
    await expect(executor.apply(route, {
      subject: { appId: 'account' }, environment: 'PROD' as any,
    })).rejects.toThrow('Billing environment must be prod or dev');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(credits.observe).not.toHaveBeenCalled();
  });

  it('accepts enum dev and rejects boundary mode changes', async () => {
    const credits = {
      reserve: jest.fn(), rollback: jest.fn(),
      observe: jest.fn()
        .mockResolvedValueOnce(observation('api-event', 'API', 5))
        .mockResolvedValueOnce(observation('txn-event', 'TXN', 25)),
    };
    const executor = new CreditPolicyExecutor(credits as any, catalog);
    const applied = await executor.apply(route, {
      subject: { appId: 'account' }, requestId: 'request-dev',
      environment: CreditEnvironment.DEV,
    });

    await expect(executor.claim(route, {
      subject: { appId: 'account' },
      requestId: 'request-dev',
      environment: CreditEnvironment.DEV,
    }, applied)).resolves.toBe(applied);
    await expect(executor.claim(route, {
      subject: { appId: 'account' },
      requestId: 'request-dev',
      environment: CreditEnvironment.PROD,
    }, applied)).rejects.toThrow('Early credit reservation does not match');
  });
});

function observation(eventId: string, creditType: string, amount: number) {
  return {
    eventId, requestId: `request-dev:${creditType.toLowerCase()}`,
    scopeId: `scope-${creditType}`,
    environment: CreditEnvironment.DEV,
    billingMode: CreditBillingMode.OBSERVE,
    requestedAmount: amount,
    deductedAmount: 0 as const, existing: false,
    operation: 'POST /submit', subject: { appId: 'account', creditType },
  };
}
