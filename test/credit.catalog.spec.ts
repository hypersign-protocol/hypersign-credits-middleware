import { Controller, Get } from '@nestjs/common';
import { MetadataScanner } from '@nestjs/core';
import { CreditCatalogAuditor } from '../src/credit.catalog-auditor';
import { CreditCatalogService } from '../src/credit.catalog';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';
import {
  CreditServiceType,
  CreditSettlementMode,
} from '../src/credit.enums';
import { resolveCreditOptions } from '../src/credit.module';

const catalogOptions = (routes: any[]) => ({
  ...DEFAULT_CREDIT_OPTIONS,
  catalog: { serviceType: 'catalog-test', version: '1', routes },
});

describe('CreditCatalogService', () => {
  it('uses the source-test KYC catalog and ignores runtime catalog overrides', () => {
    const resolved = resolveCreditOptions({
      catalog: {
        serviceType: 'attempted-override',
        version: '999',
        routes: [],
      },
    } as any);

    expect(resolved.catalog.serviceType).toBe(CreditServiceType.CAVACH_API);
    expect(resolved.catalog.routes.length).toBeGreaterThan(0);
  });

  it('exports every build-profile protocol identity', () => {
    expect(CreditServiceType).toMatchObject({
      EXAMPLE_API: 'EXAMPLE_API',
      SSI_API: 'SSI_API',
      CAVACH_API: 'CAVACH_API',
    });
  });

  it('enables internal transport defaults and supports explicit disablement', () => {
    const defaults = resolveCreditOptions({});
    expect(defaults.leaseMs).toBe(60_000);
    expect(defaults.retentionMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(defaults.terminalPlanRetentionCount).toBe(100);
    expect(defaults.transport).toEqual({
      prefix: 'bull',
      lifecycleQueueNames: ['credit.lifecycle'],
      commandQueueName: 'credit.commands.CAVACH_API',
      consumerGroup: 'credit-bull-relay:CAVACH_API',
      batchSize: 100,
      blockMs: 5_000,
      pendingIdleMs: 30_000,
    });
    expect(resolveCreditOptions({
      transport: { prefix: ' credit-bull ' },
    }).transport).toMatchObject({ prefix: 'credit-bull' });
    expect(resolveCreditOptions({ transport: false }).transport).toBe(false);
  });

  it('normalizes the configured default URI version', () => {
    const catalog = new CreditCatalogService({
      ...DEFAULT_CREDIT_OPTIONS,
      catalog: {
        serviceType: 'kyc', version: '1', defaultVersion: ' 1 ', routes: [],
      },
    });
    expect(catalog.defaultVersion).toBe('1');
  });

  it('matches canonical paths, parameters, and ignores query strings', () => {
    const catalog = new CreditCatalogService(catalogOptions([
      { method: 'GET', path: '/users/me', charges: [] },
      {
        method: 'GET', path: '/users/:userId',
        charges: [{ id: 'read', creditType: 'API', amount: 2 }],
      },
    ]));

    expect(catalog.find('get', '/users/me?full=true')?.charges).toHaveLength(0);
    expect(catalog.find('GET', '/users/user_1')?.charges[0].amount).toBe(2);
  });

  it('rejects duplicate routes and duplicate charge identifiers', () => {
    expect(() => new CreditCatalogService(catalogOptions([
      { method: 'GET', path: '/same', charges: [] },
      { method: 'get', path: '/same/', charges: [] },
    ]))).toThrow('Duplicate credit catalog route');

    expect(() => new CreditCatalogService(catalogOptions([{
      method: 'POST', path: '/pay', charges: [
        { id: 'api', creditType: 'API', amount: 1 },
        { id: 'api', creditType: 'TXN', amount: 2 },
      ],
    }]))).toThrow('Duplicate charge id');
  });

  it('requires explicit positive charges and valid deferred recovery policy', () => {
    expect(() => new CreditCatalogService(catalogOptions([{
      method: 'POST', path: '/pay',
      charges: [{ id: 'api', creditType: 'API', amount: 0 }],
    }]))).toThrow('positive safe integer');

    expect(() => new CreditCatalogService(catalogOptions([{
      method: 'POST', path: '/pay', charges: [{
        id: 'api', creditType: 'API', amount: 1,
        settlementMode: CreditSettlementMode.IMMEDIATE,
        autoRecover: false,
      }],
    }]))).toThrow('requires DEFERRED');
  });

  it('resolves conditional charges from own request-body properties', () => {
    const catalog = new CreditCatalogService(catalogOptions([{
      method: 'POST', path: '/issue', charges: [
        { id: 'api', creditType: 'API', amount: 5 },
        {
          id: 'txn', creditType: 'TXN', amount: 2_000,
          when: {
            source: 'body', path: 'registerCredentialStatus',
            operator: 'notEquals', value: false,
          },
        },
      ],
    }]));
    const route = catalog.find('POST', '/issue')!;

    expect(catalog.forRequest(route, { body: {} }).charges.map(({ id }) => id))
      .toEqual(['api', 'txn']);
    expect(catalog.forRequest(route, {
      body: { registerCredentialStatus: true },
    }).charges.map(({ id }) => id)).toEqual(['api', 'txn']);
    expect(catalog.forRequest(route, {
      body: { registerCredentialStatus: false },
    }).charges.map(({ id }) => id)).toEqual(['api']);
    expect(catalog.forRequest(route, {
      body: { registerCredentialStatus: 'false' },
    }).charges.map(({ id }) => id)).toEqual(['api', 'txn']);
    expect(route.charges).toHaveLength(2);
  });

  it('supports nested exists conditions without reading inherited properties', () => {
    const catalog = new CreditCatalogService(catalogOptions([{
      method: 'PATCH', path: '/did', charges: [{
        id: 'txn', creditType: 'TXN', amount: 1_000,
        when: { source: 'body', path: 'didDocument.id', operator: 'exists' },
      }],
    }]));
    const route = catalog.find('PATCH', '/did')!;

    expect(catalog.forRequest(route, {
      body: { didDocument: { id: 'did:hid:123' } },
    }).charges).toHaveLength(1);
    expect(catalog.forRequest(route, {
      body: { didDocument: Object.create({ id: 'did:hid:inherited' }) },
    }).charges).toHaveLength(0);
  });

  it('rejects malformed or unsafe charge conditions at startup', () => {
    const conditionCatalog = (when: unknown) => catalogOptions([{
      method: 'POST', path: '/pay', charges: [{
        id: 'api', creditType: 'API', amount: 1, when,
      }],
    }]);

    expect(() => new CreditCatalogService(conditionCatalog({
      source: 'query', path: 'paid', operator: 'equals', value: true,
    }) as any)).toThrow('.source must be body');
    expect(() => new CreditCatalogService(conditionCatalog({
      source: 'body', path: '__proto__.paid', operator: 'exists',
    }) as any)).toThrow('safe dot-separated property path');
    expect(() => new CreditCatalogService(conditionCatalog({
      source: 'body', path: 'paid', operator: 'equals',
    }) as any)).toThrow('.value must be');
    expect(() => new CreditCatalogService(conditionCatalog({
      source: 'body', path: 'paid', operator: 'exists', value: true,
    }) as any)).toThrow('.value must be omitted');
  });
});

@Controller('items')
class AuditedController {
  @Get(':itemId')
  find() {}
}

describe('CreditCatalogAuditor', () => {
  const discovery = {
    getControllers: () => [{
      metatype: AuditedController,
      instance: new AuditedController(),
    }],
  };

  it('accepts an exact application/catalog route set', () => {
    const options = catalogOptions([
      { method: 'GET', path: '/items/:itemId', charges: [] },
    ]);
    const auditor = new CreditCatalogAuditor(
      discovery as any,
      new MetadataScanner(),
      new CreditCatalogService(options),
      options,
    );
    expect(() => auditor.onApplicationBootstrap()).not.toThrow();
  });

  it('applies the catalog default version to unversioned controllers', () => {
    const options = {
      ...catalogOptions([]),
      catalog: {
        serviceType: 'catalog-test', version: '1', globalPrefix: 'api',
        defaultVersion: '1',
        routes: [{ method: 'GET', path: '/api/v1/items/:itemId', charges: [] }],
      },
    };
    const auditor = new CreditCatalogAuditor(
      discovery as any,
      new MetadataScanner(),
      new CreditCatalogService(options),
      options,
    );
    expect(() => auditor.onApplicationBootstrap()).not.toThrow();
  });

  it('fails startup when an application route is missing from the catalog', () => {
    const options = catalogOptions([]);
    const auditor = new CreditCatalogAuditor(
      discovery as any,
      new MetadataScanner(),
      new CreditCatalogService(options),
      options,
    );
    expect(() => auditor.onApplicationBootstrap())
      .toThrow('application route missing from catalog: GET /items/:itemId');
  });
});
