# Hypersign Credit Middleware v5

Catalog-driven credit enforcement for NestJS, backed by atomic Redis Lua
transactions and BullMQ lifecycle transport.

- [Complete integration procedure](docs/integration-guide.md)
- [Developer reference](docs/developer-guide.md)
- [Technical architecture](docs/technical-architecture.md)
- [Redis keyspace](docs/redis-keyspace.md)
- [Lua state transitions](docs/lua-scripts.md)
- [Production credit debugging runbook](docs/production-credit-debugging.md)

## Build profiles

Catalog selection happens at build time. Each command creates one installable
tarball containing exactly one runtime catalog:

```sh
npm run build:example # EXAMPLE_API -> *-example.tgz
npm run build:ssi     # SSI_API     -> *-ssi.tgz
npm run build:kyc     # CAVACH_API  -> *-kyc.tgz
npm run build         # builds and verifies all three profiles
```

Install the artifact that matches the host service. The selected catalog is
immutable at runtime; passing a catalog through module options does not replace
the bundled catalog.

## Runtime contract

- Each SDK artifact bundles exactly one route and price catalog. Controllers do
  not declare prices.
- A catalog charge may include an optional request-body `when` condition.
  Charges without one remain unconditional.
- Startup fails when the NestJS route table and bundled catalog differ.
- The host provides one `CREDIT_REDIS_CLIENT`. The SDK creates and closes its
  own Redis Stream and BullMQ connections.
- SDK defaults cover leases, retention, recovery batches, Stream limits, and
  queue names.
- `prod` requests enforce credit. `dev` requests emit usage events with zero
  deduction. The value is trusted per-request metadata, not a process-wide
  environment setting.

Use exported enums for protocol values:

```ts
CreditEnvironment.PROD // 'prod'
CreditEnvironment.DEV  // 'dev'
CreditServiceType.EXAMPLE_API
CreditServiceType.SSI_API
CreditServiceType.CAVACH_API // catalog and transport identity
CreditAppType.SSI_API
CreditAppType.CAVACH_API     // subject.appType wallet dimension
CreditType.API_CREDIT
CreditType.BLOCKCHAIN_TXN_CREDIT
```

Uppercase `PROD` and `DEV` are invalid environment inputs.

## Installation

```sh
npm install @hypersign-protocol/credit-middleware ioredis @nestjs/schedule
```

The package includes BullMQ. Do not register a BullMQ provider or Redis Stream
client for the SDK.

## Registration

```ts
import { UnauthorizedException } from '@nestjs/common';
import {
  CreditAppType,
  CreditEnvironment,
  CreditModule,
  CreditType,
} from '@hypersign-protocol/credit-middleware';

CreditModule.forRootAsync({
  imports: [CreditInfrastructureModule],
  useFactory: () => ({
    requestContextResolver: (unknownRequest: unknown) => {
      const request = unknownRequest as AuthenticatedRequest;
      const appId = request.service?.appId?.trim();
      const environment = request.service?.env?.trim();

      if (!appId) {
        throw new UnauthorizedException('Trusted service appId is required');
      }
      if (
        environment !== CreditEnvironment.PROD &&
        environment !== CreditEnvironment.DEV
      ) {
        throw new UnauthorizedException(
          'Trusted service environment must be prod or dev',
        );
      }

      return {
        subject: {
          tenantId: request.service?.subdomain?.trim() || undefined,
          appId,
          appType: CreditAppType.CAVACH_API,
          creditType: CreditType.API_CREDIT,
        },
        requestId: request.requestId,
        environment,
      };
    },
  }),
});
```

Authentication must populate the request context before the global credit
interceptor runs. Do not accept wallet identity or environment from an
unauthenticated body, query parameter, or header.

See the [integration guide](docs/integration-guide.md) for the Redis provider,
Nest module, scheduler, and verification flow.

## Wallets and plans

A wallet is identified by:

```text
tenantId + appType + appId + creditType
```

All values are trimmed and case-sensitive. `serviceType` is transport metadata
and is not part of wallet identity.

Each grant creates an immutable plan with its own amount, grant time, expiry,
reference, and critical-balance threshold. Plans are consumed by `grantedAt`,
then `planId`.

Full metadata is retained for every unfinished plan and, by default, the newest
100 depleted, expired, or revoked plans per wallet. Older terminal metadata is
removed only after all SDK-tracked reservations referencing that plan finalize.
Persistent ownership and grant-reference records still prevent an old payment
from being applied twice. Configure the full-history limit with
`terminalPlanRetentionCount`.

```ts
await creditService.grant({
  subject,
  planId: 'plan_01',
  amount: 100,
  criticalBalance: 40,
  grantedAt: Date.now(),
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
  referenceId: 'payment_01',
});
```

A reservation may span several plans. Allocation is all-or-nothing: if the
complete price cannot be funded, no plan is changed. Commit, rollback, and
recovery use the allocations stored on the reservation rather than recalculating
FIFO order.

Grant retries are idempotent when every immutable field matches. Reusing a
`planId` or `referenceId` with different semantics is rejected.

## Request behavior

```text
catalog match
  -> retain only charges whose optional request-body condition matches
  -> resolve trusted subject and environment
  -> prod: reserve plan allocations
  -> dev: emit CREDIT_OBSERVED with deductedAmount=0
  -> execute controller
  -> prod: commit, retain deferred work, or roll back
```

Before the first plan grant, `getBalance()` returns `null` and priced `prod`
requests return HTTP 402. A plan stored only in an external database cannot
fund a request; the SDK must first apply its grant command.

## Transport

Default queues:

| Purpose | Queue |
| --- | --- |
| Lifecycle events | `credit.lifecycle` |
| Trusted commands | `credit.commands.CAVACH_API` |

Transport envelopes use `schemaVersion: 3`. BullMQ delivery is at least once;
lifecycle consumers must enforce a durable unique constraint on `eventId`.
Workers on the same queue compete. Use separate lifecycle queue names when
multiple systems each need every event.

## Recovery

Run recovery every five minutes:

```ts
@Cron(CronExpression.EVERY_5_MINUTES, {
  name: 'credit-recovery',
  waitForCompletion: true,
})
async run(): Promise<void> {
  await this.creditRecoveryService.runOnce();
}
```

One pass handles expired reservation leases and expired unused plan credit.
Redis transactions make concurrent recovery workers safe.

## Repository examples

The repository contains host integration modules and a runnable external
grant/lifecycle process:

```sh
npm run build:example
npm run start:example:events
```

The examples are not included in the npm package or public import surface.
Instructions are in [example/README.md](example/README.md).

## Production requirements

- Redis 6.2+ with authentication, TLS, AOF, replication, tested backups, and
  `noeviction`.
- Stable request, plan, command, and payment identifiers.
- A five-minute recovery schedule.
- Idempotent lifecycle persistence keyed by `eventId`.
- Monitoring for HTTP 402 rates, rejected commands, BullMQ failures, recovery
  backlog, and pending Stream entries.
- An `eventStreamMaxLength` large enough for the longest expected relay outage.

Redis state uses `<keyPrefix>:v2:{<hashTag>}:...`.
