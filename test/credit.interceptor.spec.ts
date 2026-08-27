import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { CreditCatalogService } from '../src/credit.catalog';
import { CREDIT_BOUNDARY_STATE } from '../src/credit-boundary.middleware';
import {
  CREDIT_REQUEST_STATE,
  CreditInterceptor,
} from '../src/credit.interceptor';
import {
  AppliedCreditObservation,
  AppliedCreditReservation,
  CreditPolicyExecutor,
} from '../src/credit-policy.executor';
import { CreditService, InsufficientCreditsException } from '../src/credit.service';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditSettlementMode,
} from '../src/credit.enums';

const options = {
  ...DEFAULT_CREDIT_OPTIONS,
  catalog: {
    serviceType: 'test-service',
    version: '1',
    routes: [
      {
        method: 'POST', path: '/api/jobs',
        charges: [{ id: 'api', creditType: 'API_CREDIT', amount: 20 }],
      },
      {
        method: 'POST', path: '/api/blockchain',
        charges: [
          { id: 'api', creditType: 'API_CREDIT', amount: 5 },
          {
            id: 'txn', creditType: 'BLOCKCHAIN_CREDIT', amount: 25,
            settlementMode: CreditSettlementMode.DEFERRED,
            autoRecover: false,
          },
        ],
      },
      { method: 'GET', path: '/api/free', charges: [] },
    ],
  },
};

const subject = { appId: 'user_123' };
const reservation = (
  id: string,
  mode: CreditSettlementMode = CreditSettlementMode.IMMEDIATE,
): AppliedCreditReservation => ({
  billingMode: CreditBillingMode.ENFORCE,
  charge: {
    id: id.includes('deferred') ? 'txn' : 'api',
    creditType: id.includes('deferred') ? 'BLOCKCHAIN_CREDIT' : 'API_CREDIT',
    amount: id.includes('deferred') ? 25 : 20,
    settlementMode: mode,
    autoRecover: mode === CreditSettlementMode.IMMEDIATE,
  },
  reservation: {
    reservationId: id,
    leaseToken: 'lease',
    scopeId: 'scope',
    remainingBalance: 80,
    expiresAt: Date.now() + 60_000,
    autoRecover: mode === CreditSettlementMode.IMMEDIATE,
    environment: CreditEnvironment.PROD,
    billingMode: CreditBillingMode.ENFORCE,
    existing: false,
    settlementMode: mode,
    subject,
    allocations: [{ planId: 'plan-1', amount: 20, planBalanceAfter: 80 }],
  },
});

const observation = (): AppliedCreditObservation => ({
  billingMode: CreditBillingMode.OBSERVE,
  charge: {
    id: 'api', creditType: 'API_CREDIT', amount: 20,
    settlementMode: CreditSettlementMode.IMMEDIATE,
    autoRecover: true,
  },
  observation: {
    eventId: '100-0', requestId: 'request_1:api', scopeId: 'scope',
    environment: CreditEnvironment.DEV,
    billingMode: CreditBillingMode.OBSERVE,
    requestedAmount: 20, deductedAmount: 0 as const, existing: false,
    operation: 'POST /api/jobs', subject: { ...subject, creditType: 'API_CREDIT' },
  },
});

const httpContext = (request: Record<PropertyKey, unknown>): ExecutionContext => ({
  getType: () => 'http',
  switchToHttp: () => ({ getRequest: () => request }),
} as unknown as ExecutionContext);

describe('catalog-driven CreditInterceptor', () => {
  const credits = { commit: jest.fn() } as unknown as jest.Mocked<CreditService>;
  const executor = {
    apply: jest.fn(),
    claim: jest.fn(),
    rollbackAll: jest.fn(),
  } as unknown as jest.Mocked<CreditPolicyExecutor>;
  const configured = {
    ...options,
    requestContextResolver: (request: unknown) => ({
      subject,
      requestId: 'request_1',
      environment:
        (request as { environment?: CreditEnvironment }).environment ??
        CreditEnvironment.PROD,
    }),
  };
  const catalog = new CreditCatalogService(configured);
  const interceptor = new CreditInterceptor(catalog, executor, credits, configured);

  beforeEach(() => {
    jest.clearAllMocks();
    credits.commit.mockResolvedValue(true);
    executor.rollbackAll.mockResolvedValue();
  });

  it('reserves from the catalog and commits an immediate charge', async () => {
    const request: Record<PropertyKey, unknown> = {
      method: 'POST', originalUrl: '/api/jobs?trace=1',
    };
    executor.apply.mockResolvedValue([reservation('res_1')]);

    await expect(lastValueFrom(interceptor.intercept(
      httpContext(request),
      { handle: () => of({ ok: true }) } as CallHandler,
    ))).resolves.toEqual({ ok: true });

    expect(executor.apply).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/jobs', operation: 'POST /api/jobs' }),
      {
        subject,
        requestId: 'request_1',
        environment: CreditEnvironment.PROD,
      },
    );
    expect(credits.commit).toHaveBeenCalledWith('res_1');
    expect(request[CREDIT_REQUEST_STATE]).toBeDefined();
  });

  it('runs an explicitly free catalog route without resolving credit context', async () => {
    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'GET', originalUrl: '/api/free' }),
      { handle: () => of('free') } as CallHandler,
    ))).resolves.toBe('free');
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it('rejects a runtime route that is absent from the catalog', () => {
    expect(() => interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/unknown' }),
      { handle: () => of('never') } as CallHandler,
    )).toThrow('Credit catalog mismatch');
  });

  it('commits immediate charges and leaves deferred charges reserved', async () => {
    executor.apply.mockResolvedValue([
      reservation('res_api'),
      reservation('res_deferred', CreditSettlementMode.DEFERRED),
    ]);

    await lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/blockchain' }),
      { handle: () => of('accepted') } as CallHandler,
    ));

    expect(credits.commit).toHaveBeenCalledTimes(1);
    expect(credits.commit).toHaveBeenCalledWith('res_api');
  });

  it('does not execute the controller and preserves a reserve failure', async () => {
    executor.apply.mockRejectedValue(new InsufficientCreditsException());
    const next = { handle: jest.fn(() => of('never')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/jobs' }),
      next,
    ))).rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rolls back every reservation when the controller fails', async () => {
    const applied = [reservation('res_1')];
    const failure = new Error('controller failed');
    executor.apply.mockResolvedValue(applied);

    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/jobs' }),
      { handle: () => throwError(() => failure) } as CallHandler,
    ))).rejects.toBe(failure);
    expect(executor.rollbackAll).toHaveBeenCalledWith(applied, 'controller failed');
  });

  it('claims catalog reservations made by the early boundary', async () => {
    const applied = [reservation('res_boundary')];
    const route = catalog.find('POST', '/api/jobs')!;
    const boundary = {
      route,
      actions: applied,
      claimedByInterceptor: false,
      finalized: false,
    };
    executor.claim.mockResolvedValue(applied);
    const request = {
      method: 'POST', originalUrl: '/api/jobs',
      [CREDIT_BOUNDARY_STATE]: boundary,
    };

    await lastValueFrom(interceptor.intercept(
      httpContext(request),
      { handle: () => of('ok') } as CallHandler,
    ));

    expect(executor.apply).not.toHaveBeenCalled();
    expect(executor.claim).toHaveBeenCalled();
    expect(boundary.claimedByInterceptor).toBe(true);
    expect(boundary.finalized).toBe(true);
  });

  it('executes a dev request after observation without committing credit', async () => {
    const request: Record<PropertyKey, unknown> = {
      method: 'POST',
      originalUrl: '/api/jobs',
      environment: CreditEnvironment.DEV,
    };
    executor.apply.mockResolvedValue([observation()]);

    await expect(lastValueFrom(interceptor.intercept(
      httpContext(request),
      { handle: () => of({ ok: true }) } as CallHandler,
    ))).resolves.toEqual({ ok: true });

    expect(executor.apply).toHaveBeenCalledWith(expect.anything(), {
      subject,
      requestId: 'request_1',
      environment: CreditEnvironment.DEV,
    });
    expect(credits.commit).not.toHaveBeenCalled();
    expect(request[CREDIT_REQUEST_STATE]).toEqual(expect.objectContaining({
      actions: [expect.objectContaining({
        billingMode: CreditBillingMode.OBSERVE,
      })],
    }));
  });
});
