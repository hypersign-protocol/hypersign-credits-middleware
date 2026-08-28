import { EventEmitter } from 'node:events';
import { CreditCatalogService } from '../src/credit.catalog';
import {
  CREDIT_BOUNDARY_STATE,
  CreditBoundaryMiddleware,
} from '../src/credit-boundary.middleware';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditSettlementMode,
} from '../src/credit.enums';

describe('catalog-driven CreditBoundaryMiddleware', () => {
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: {
      serviceType: 'test', version: '1', routes: [
        {
          method: 'POST', path: '/paid/:id', boundary: true,
          charges: [
            { id: 'api', creditType: 'API_CREDIT', amount: 10 },
            {
              id: 'txn', creditType: 'BLOCKCHAIN_TXN_CREDIT', amount: 2_000,
              when: {
                source: 'body' as const, path: 'onChain',
                operator: 'equals' as const, value: true,
              },
            },
          ],
        },
        { method: 'GET', path: '/free', charges: [] },
      ],
    },
    requestContextResolver: () => ({
      subject: { appId: 'user_123' },
      requestId: 'req_1',
      environment: CreditEnvironment.PROD,
    }),
  };
  const catalog = new CreditCatalogService(options);
  const applied = [{
    billingMode: CreditBillingMode.ENFORCE,
    charge: catalog.find('POST', '/paid/123')!.charges[0],
    reservation: {
      reservationId: 'res_1', remainingBalance: 90, leaseToken: 'lease_1',
      scopeId: 'scope_1', subject: { appId: 'user_123' }, allocations: [
        { planId: 'plan-1', amount: 10, planBalanceAfter: 90 },
      ],
      expiresAt: Date.now() + 60_000, existing: false, autoRecover: true,
      environment: CreditEnvironment.PROD,
      billingMode: CreditBillingMode.ENFORCE,
      settlementMode: CreditSettlementMode.IMMEDIATE,
    },
  }];
  const executor = { apply: jest.fn(), rollbackAll: jest.fn() };
  const middleware = new CreditBoundaryMiddleware(catalog, executor as any, options);

  beforeEach(() => {
    jest.clearAllMocks();
    executor.apply.mockResolvedValue(applied);
    executor.rollbackAll.mockResolvedValue(undefined);
  });

  it('rolls back if later middleware ends before the interceptor', async () => {
    const request: any = { method: 'POST', originalUrl: '/paid/123' };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    response.emit('finish');
    await Promise.resolve();
    expect(executor.rollbackAll).toHaveBeenCalledWith(
      applied, 'response_ended_before_credit_interceptor',
    );
  });

  it('leaves reservations claimed by the interceptor alone', async () => {
    const request: any = { method: 'POST', originalUrl: '/paid/123' };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    request[CREDIT_BOUNDARY_STATE].claimedByInterceptor = true;
    response.emit('finish');
    await Promise.resolve();
    expect(executor.rollbackAll).not.toHaveBeenCalled();
  });

  it('does not reserve routes without boundary=true', async () => {
    const next = jest.fn();
    await middleware.use(
      { method: 'GET', originalUrl: '/free' },
      new EventEmitter() as any,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it('passes only matching charges into the early boundary reservation', async () => {
    const request: any = {
      method: 'POST', originalUrl: '/paid/123', body: { onChain: false },
    };
    await middleware.use(request, new EventEmitter() as any, jest.fn());

    expect(executor.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        charges: [expect.objectContaining({ id: 'api' })],
      }),
      expect.anything(),
    );
    expect(request[CREDIT_BOUNDARY_STATE].route.charges).toHaveLength(1);
  });
});
