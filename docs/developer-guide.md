# Hypersign Credit Middleware developer reference

Configuration, protocol, storage, and operations reference for
`@hypersign-protocol/credit-middleware`.

> SDK version: `5.0.0`
> Bundled catalog: `CAVACH_API@3.21.1`
> Supported runtime: Node.js 18+, NestJS 9–11, Redis 6.2+

## Contents

- [Integration guide](integration-guide.md)
- [Overview](#overview)
- [Domain enums](#domain-enums)
- [Integration path](#integration-path)
- [Integration requirements](#integration-requirements)
- [Installation](#installation)
- [Configure Redis](#configure-redis)
- [Deterministic Redis keys](#deterministic-redis-keys)
- [BullMQ queues and keys](#bullmq-queues-and-keys)
- [Register the SDK](#register-the-sdk)
- [Per-request billing environment](#per-request-billing-environment)
- [Request identity and idempotency](#request-identity-and-idempotency)
- [Grant credits](#grant-credits)
- [Automatic HTTP charging](#automatic-http-charging)
- [Deferred settlement](#deferred-settlement)
- [Recovery](#recovery)
- [BullMQ transport](#bullmq-transport)
- [Lifecycle events](#lifecycle-events)
- [Command messages](#command-messages)
- [Service API reference](#service-api-reference)
- [Configuration reference](#configuration-reference)
- [Errors and HTTP behavior](#errors-and-http-behavior)
- [Production operations](#production-operations)
- [Testing](#testing)
- [Upgrade notes](#upgrade-notes)

## Overview

The SDK applies catalog-defined credit charges to NestJS HTTP routes. It uses
Redis Lua scripts so that plan selection, balance changes, reservation state,
idempotency records, and lifecycle events change atomically.

```text
authenticated request
        |
        v
resolve trusted billing subject
        |
        v
match route in bundled catalog
        |
        v
reserve from unexpired plans (FIFO)
        |
        +---- request fails ------> roll back eligible allocations
        |
        +---- request succeeds ---> commit IMMEDIATE allocations
                                  \-> retain DEFERRED allocations
```

Credits are stored as immutable recharge plans. Plans are consumed in
`grantedAt` order, then by `planId` when timestamps are equal. A reservation is
all-or-nothing: if the entire charge cannot be funded, no plan is deducted.

The exact plan allocation is stored with the reservation. Commit, rollback,
and recovery use that stored allocation and never recalculate FIFO order.

## Domain enums

Use the SDK's exported enums instead of repeating protocol strings in
TypeScript. Enum member names remain uppercase; only the environment wire
values are lowercase.

| Enum | Members and values |
| --- | --- |
| `CreditEnvironment` | `PROD = 'prod'`, `DEV = 'dev'` |
| `CreditBillingMode` | `ENFORCE`, `OBSERVE` |
| `CreditSettlementMode` | `IMMEDIATE`, `DEFERRED` |
| `CreditPlanStatus` | `ACTIVE`, `DEPLETED`, `EXPIRED`, `REVOKED` |
| `CreditReservationStatus` | `RESERVED`, `COMMITTED`, `ROLLED_BACK`, `EXPIRED` |
| `CreditCatalogVersioning` | `URI`, `NONE` |
| `CreditServiceType` | `CAVACH_API`; identifies the catalog, command envelope, lifecycle envelope, and transport namespace. It is not a wallet dimension. |
| `CreditAppType` | `CAVACH_API`; identifies `subject.appType` and is part of the wallet key. Grants and requests must match it. |
| `CreditType` | `API_CREDIT` |
| `CreditEventType` | Redis outbox event types such as `CREDIT_GRANTED` and `CREDIT_OBSERVED` |
| `CreditEventName` | BullMQ names such as `credit.granted` and `credit.grant.requested` |

Example:

```ts
import {
  CreditAppType,
  CreditBillingMode,
  CreditEnvironment,
  CreditEventName,
  CreditSettlementMode,
  CreditServiceType,
  CreditType,
} from '@hypersign-protocol/credit-middleware';
```

Incoming JSON and Redis/BullMQ payloads contain the enum values, not member
expressions. For example, `CreditEnvironment.PROD` is serialized as `"prod"`.

## Integration path

Use the [integration guide](integration-guide.md) for the complete API-host and
event-service setup. The host integration modules and runnable external process
are under [`example/`](../example/README.md).

Runtime responsibilities are divided as follows:

| Component | Responsibility |
| --- | --- |
| NestJS API host | Supplies trusted request identity and environment, imports `CreditModule`, and schedules recovery. |
| Credit SDK | Audits routes, applies atomic Redis transitions, runs the command worker, and relays lifecycle events. |
| Trusted plan producer | Publishes plan grants to `credit.commands.CAVACH_API` after payment or onboarding. |
| Lifecycle consumer | Persists `credit.lifecycle` events idempotently using envelope `eventId`. |

The sections below are the configuration, protocol, storage, and operations
reference.

## Integration requirements

### Fixed route catalog

This release bundles its authoritative route and pricing catalog at
`src/catalogs/catalog.kyc.json`. Applications cannot supply or override the
catalog through `CreditModule` configuration.

The bundled catalog uses:

- service type `CAVACH_API`;
- catalog version `3.21.1`;
- global prefix `api`;
- URI versioning with prefix `v`; and
- default controller version `1`.

During application bootstrap, the SDK compares every discovered Nest HTTP
route with the catalog. Startup fails if:

- an application route is missing from the catalog;
- a catalog route is missing from the application;
- the application declares a duplicate resolved route; or
- a catalog route or charge is invalid.

Controller changes and catalog changes must ship together in a new SDK
release. Treat a route-audit failure as a deployment-blocking compatibility
error.

### Wallet identity

A wallet is uniquely identified by all supplied `CreditSubject` dimensions:

```ts
interface CreditSubject {
  appId: string;
  tenantId?: string;
  appType?: CreditAccountType | string;
  creditType?: string;
}
```

Omitted dimensions are meaningful. These are different wallets:

```ts
{ appId: 'app:123' }
{ appId: 'app:123', appType: CreditAppType.CAVACH_API }
```

`serviceType` and `serviceId` are not part of wallet identity. HTTP charges take
`creditType` from the matched catalog route.

### Required infrastructure

A production deployment needs:

- Redis 6.2 or later;
- one non-blocking Redis connection for credit operations;
- a trusted authentication context available before credit policy runs;
- stable request, plan, payment, command, and event identifiers; and
- an external scheduler or worker for credit recovery.

Transport is enabled by default. The SDK creates its own blocking Stream and
BullMQ connections by duplicating the operation client supplied by the host.

## Installation

```sh
npm install @hypersign-protocol/credit-middleware ioredis
```

The host must provide compatible peer dependencies:

```sh
npm install @nestjs/common @nestjs/core rxjs reflect-metadata
```

## Configure Redis

Provide an ioredis-compatible operation client under the exported
`CREDIT_REDIS_CLIENT` token.

```ts
// credit-infrastructure.module.ts
import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CREDIT_REDIS_CLIENT } from '@hypersign-protocol/credit-middleware';

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CREDIT_REDIS_CLIENT,
      useFactory: async (): Promise<Redis> => {
        const client = new Redis(process.env.REDIS_URL!, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
        });
        await client.ping();
        return client;
      },
    },
    RedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class CreditInfrastructureModule {}
```

The host owns and closes only this operation client. The SDK calls its ioredis
`duplicate()` method to create dedicated Stream and BullMQ connections with
`maxRetriesPerRequest: null`, then closes those owned connections during Nest
shutdown. A custom object without `duplicate()` is valid only when transport is
disabled with `transport: false`.

## Deterministic Redis keys

The SDK constructs every state key from normalized configuration, wallet
identity, and stable business identifiers. Given the same inputs, every API
instance and recovery worker derives exactly the same keys without consulting
a registry or database.

### Versioned key base

All SDK-owned Redis keys begin with:

```text
<keyPrefix>:v2:{<redisHashTag>}
```

With this configuration:

```ts
{
  keyPrefix: 'hypersign-credit',
  redisHashTag: 'hypersign-credit'
}
```

the base is:

```text
hypersign-credit:v2:{hypersign-credit}
```

The braces are Redis Cluster hash-tag syntax. Redis hashes only the text inside
the braces, so every key passed to a multi-key Lua transition occupies the same
Cluster slot. The SDK rejects braces inside either configuration value to
prevent an ambiguous or broken tag.

`v2` is the storage-schema version, not the npm package version or catalog
version. Changing `keyPrefix` or `redisHashTag` points the application at a
different logical keyspace. Treat either change as a data migration, not a
cosmetic rename.

Use a unique `keyPrefix` for each independently operated SDK deployment or
financial namespace. Do not change it for per-request `prod`/`dev` values. The
service type is not included in financial keys and does not isolate wallets.

### Deterministic wallet scope

The wallet scope uses four dimensions in this fixed order:

```text
tenant, appType, app, creditType
```

Each value is trimmed. An absent or empty optional dimension becomes `0`; a
present value becomes `1:<URI-encoded-value>`. Dimension names and presence
markers prevent ambiguous concatenation.

For this subject:

```ts
import {
  CreditAppType,
  CreditType,
} from '@hypersign-protocol/credit-middleware';

const subject = {
  tenantId: 'tenant/acme',
  appType: CreditAppType.CAVACH_API,
  appId: 'app:123',
  creditType: CreditType.API_CREDIT,
};
```

the deterministic scope ID is:

```text
tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
```

If `tenantId` and `appType` are absent, the scope begins:

```text
tenant=0|appType=0|...
```

Case is preserved: `business` and `BUSINESS` are different values. Scope IDs
and Redis keys contain business identifiers in encoded—not encrypted—form.
Treat Redis key names as sensitive metadata and restrict key enumeration.

### Exact SDK key patterns

`<base>` below means `<keyPrefix>:v2:{<redisHashTag>}` and `<scope>` means the
deterministic scope ID above.

| Purpose | Exact pattern | Redis type | Key/member detail |
| --- | --- | --- | --- |
| Cached wallet total | `<base>:balance:<scope>` | String | Non-negative integer maintained with mutations. |
| Active FIFO plans | `<base>:plans:order:<scope>` | Sorted set | Member is `planId`; score is `grantedAt`. Equal scores are ordered by `planId`. |
| Original plan amounts | `<base>:plans:amount:<scope>` | Hash | `planId -> granted amount`. |
| Available plan amounts | `<base>:plans:remaining:<scope>` | Hash | `planId -> currently available amount`. |
| Plan expiry times | `<base>:plans:expires:<scope>` | Hash | `planId -> Unix epoch milliseconds`. |
| Plan grant times | `<base>:plans:granted-at:<scope>` | Hash | `planId -> Unix epoch milliseconds`. |
| Plan references | `<base>:plans:reference:<scope>` | Hash | `planId -> referenceId`. |
| Plan statuses | `<base>:plans:status:<scope>` | Hash | `planId -> ACTIVE, DEPLETED, EXPIRED, or REVOKED`. |
| Plan critical balances | `<base>:plans:critical-balance:<scope>` | Hash | `planId -> immutable non-negative threshold`. |
| Plan expiry members | `<base>:plans:expiration-member:<scope>` | Hash | `planId -> encoded global-expiry member`. |
| In-flight plan references | `<base>:plans:inflight:<scope>` | Hash | Active reservation count for cleanup-safe plans. |
| Cleanup compatibility marker | `<base>:plans:tracked:<scope>` | Hash | Identifies plans whose complete reservation history is counted. |
| Terminal plan order | `<base>:plans:terminal:<scope>` | Sorted set | Orders depleted, expired, and revoked plans for bounded full-data retention. |
| Plan ownership | `<base>:plan-owner:<encoded-planId>` | Hash | Globally binds a plan ID to its scope and reference. |
| Grant idempotency | `<base>:grant:<encoded-referenceId>` | Hash | Globally binds a payment reference to immutable grant semantics. |
| Plan expiry index | `<base>:plan:expirations` | Sorted set | Score is plan expiry; member encodes subject dimensions and `planId` as JSON. |
| Reservation record | `<base>:reservation:<encoded-reservationId>` | Hash | Status, lease, subject, operation, and immutable allocations. |
| Request idempotency | `<base>:request:<scope>:<encoded-requestId>` | Hash | Maps request semantics to its reservation. HTTP charge IDs are already appended to request IDs. |
| Observation idempotency | `<base>:observation:<scope>:<encoded-requestId>` | Hash | Retains `dev` event ID, amount, operation, and environment for exact retry handling. |
| Reservation expiry index | `<base>:reservation:expirations` | Sorted set | Score is lease expiry; member is `reservationId`. |
| Transactional outbox | `<base>:events` | Stream | State-transition events written by the same Lua transaction. |

`planId`, `referenceId`, `requestId`, and `reservationId` are URI-encoded where
they appear in key names. New reservation IDs and lease tokens are random UUIDs;
keys derived from an existing reservation remain deterministic.

### Source of truth and retention

The aggregate balance key is a transactionally maintained cache. Plan order,
remaining amounts, expiries, and statuses retain the allocation detail;
`getBalance()` evaluates currently unexpired active plans so it does not report
an expired cached amount before recovery runs.

Retention behavior differs by record:

- active reservations and their request mappings have no TTL;
- finalized reservation and request keys receive `retentionMs`;
- unfinished plan metadata is persistent;
- the newest `terminalPlanRetentionCount` terminal plans retain full metadata;
- older terminal plan metadata is removed only when its tracked in-flight
  reservation count is zero;
- pre-upgrade plans are not automatically pruned, because older reservations
  cannot be counted safely;
- global plan ownership and grant idempotency records remain persistent; and
- the event Stream is approximately trimmed to `eventStreamMaxLength` by
  `XADD MAXLEN ~`.

Do not add independent TTLs or delete individual keys. An active reservation
can still reference a depleted or expired plan, and partial cleanup can make a
later settlement or audit impossible.

### Worked key example

Using the configuration and subject above, representative keys are:

```text
hypersign-credit:v2:{hypersign-credit}:balance:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT

hypersign-credit:v2:{hypersign-credit}:plans:remaining:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT

hypersign-credit:v2:{hypersign-credit}:request:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT:req%2F019%3Aapi

hypersign-credit:v2:{hypersign-credit}:plan-owner:plan%2F2026%2F001

hypersign-credit:v2:{hypersign-credit}:reservation:3db57c81-0000-4000-8000-000000000000

hypersign-credit:v2:{hypersign-credit}:events
```

The braces appear unchanged in every key and therefore keep all examples in
the same Redis Cluster slot.

## BullMQ queues and keys

SDK financial keys and BullMQ keys are separate namespaces with separate
construction rules.

The SDK controls:

- lifecycle and command queue names;
- lifecycle, rejection, and command job names;
- deterministic lifecycle/rejection job IDs; and
- the lifecycle and rejection data envelopes;
- its Redis Stream and BullMQ connections;
- ten delivery attempts with exponential backoff starting at one second; and
- BullMQ retention of 1,000 completed and 5,000 failed jobs.

### Queue names

| Queue role | Default name | Configuration |
| --- | --- | --- |
| Lifecycle delivery | `credit.lifecycle` | `transport.lifecycleQueueNames` |
| Trusted commands | `credit.commands.CAVACH_API` | `transport.commandQueueName` |

`CAVACH_API` comes from the bundled `serviceType`. If multiple lifecycle queue names are
configured, the SDK publishes every event to each queue before acknowledging
the Redis Stream entry.

Queue names are not wallet scopes. Workers on one queue compete; separate
delivery audiences require separate queue names.

### Physical BullMQ key patterns

With BullMQ's default prefix `bull`, physical keys generally use:

```text
bull:<queueName>:<suffix>
```

For the default queues, examples include:

```text
bull:credit.lifecycle:wait
bull:credit.lifecycle:active
bull:credit.lifecycle:delayed
bull:credit.lifecycle:completed
bull:credit.lifecycle:failed
bull:credit.lifecycle:events
bull:credit.lifecycle:meta

bull:credit.commands.CAVACH_API:wait
bull:credit.commands.CAVACH_API:active
bull:credit.commands.CAVACH_API:delayed
bull:credit.commands.CAVACH_API:failed
bull:credit.commands.CAVACH_API:events
```

BullMQ also creates job records and internal keys such as IDs, markers,
priorities, stalled checks, and dependency state. These are BullMQ
implementation details and may vary by BullMQ version. Do not read, mutate, or
expire them directly; use BullMQ APIs.

The physical prefix is `transport.prefix` and defaults to `bull`. The SDK's
`keyPrefix` and `redisHashTag` do not change BullMQ keys. Do not configure an
ioredis `keyPrefix` on `CREDIT_REDIS_CLIENT`; use SDK key options for financial
state and `transport.prefix` for BullMQ isolation.

### Deterministic job IDs

| Message | SDK/provider job ID |
| --- | --- |
| Lifecycle event | `<serviceType>-<redis-stream-eventId>` |
| Rejected command event | `<serviceType>-<commandId>-rejected` |
| Inbound command | Set by the trusted producer; normally the same stable value as `commandId`. |

Example lifecycle identifiers:

```text
Redis Stream event ID:  1787123456789-0
Service type:             CAVACH_API
BullMQ job ID:          CAVACH_API-1787123456789-0
```

The stable lifecycle job ID helps BullMQ reject a duplicate while that job
record still exists. It is not a permanent idempotency guarantee: a job can be
created again after host retention removes the old record. Downstream consumers
must enforce a durable unique constraint on envelope `eventId`.

The Redis Stream consumer group is not a BullMQ key. By default it is named
`credit-bull-relay:CAVACH_API` and is stored as metadata on the SDK outbox Stream. Each
relay process uses a unique `<process-id>-<UUID>` consumer name so pending work
can be reclaimed after `pendingIdleMs`.

## Register the SDK

`CreditModule` is global and installs `CreditInterceptor` as an
`APP_INTERCEPTOR`. Controllers need no pricing decorator.

```ts
// app.module.ts
import { Module, UnauthorizedException } from '@nestjs/common';
import {
  CreditAppType,
  CreditEnvironment,
  CreditModule,
  CreditType,
} from '@hypersign-protocol/credit-middleware';
import { CreditInfrastructureModule } from './credit-infrastructure.module';

interface AuthenticatedRequest {
  service?: {
    subdomain?: string;
    appId?: string;
    env?: string;
  };
  requestId?: string;
}

@Module({
  imports: [
    CreditInfrastructureModule,
    CreditModule.forRoot({
      keyPrefix: 'hypersign-credit',
      redisHashTag: 'hypersign-credit',
      requestContextResolver: (unknownRequest) => {
        const request = unknownRequest as AuthenticatedRequest;
        const appId = request.service?.appId?.trim();
        const environment = request.service?.env?.trim();
        if (!appId) {
          throw new UnauthorizedException(
            'Trusted service appId is required',
          );
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
  ],
})
export class AppModule {}
```

Resolve the subject and environment only from identity already verified by the
host. Never trust an `appId`, `tenantId`, `appType`, `creditType`, or environment
supplied directly by a request body, query string, or unverified header.

Use `forRootAsync()` when configuration or adapters come from Nest DI:

```ts
CreditModule.forRootAsync({
  imports: [CreditInfrastructureModule, ConfigurationModule],
  inject: [AppConfig],
  useFactory: (config: AppConfig) => ({
    keyPrefix: config.creditKeyPrefix,
    redisHashTag: config.creditHashTag,
    requestContextResolver: resolveCreditContext,
  }),
});
```

The default context resolver is a compatibility fallback. Charged requests
fail closed unless their resolver returns exactly lowercase `prod` or `dev`.
Uppercase values are rejected. Production
applications should always provide an explicit resolver.

## Per-request billing environment

One SDK server can handle both production and development calls. Environment is
trusted request metadata, not a server-wide setting and not a wallet dimension.

```ts
interface CreditRequestContext {
  subject: CreditSubject;
  requestId?: string;
  environment: CreditEnvironment;
}
```

| Request environment | Billing mode | Balance behavior | Lifecycle event |
| --- | --- | --- | --- |
| `prod` (`CreditEnvironment.PROD`) | `CreditBillingMode.ENFORCE` | Reserve and settle the catalog cost normally. | Normal financial events with `environment: 'prod'` and `billingMode: 'ENFORCE'`. |
| `dev` (`CreditEnvironment.DEV`) | `CreditBillingMode.OBSERVE` | Never reads or changes wallet, plan, or reservation balances. | One idempotent `CREDIT_OBSERVED` per catalog charge with `deductedAmount: 0`. |

Missing values and values other than lowercase `prod` or `dev` are rejected
before the controller runs. Do not default an unknown value to `dev`, because that could
silently bypass billing.

## Request identity and idempotency

Set a stable request ID before the global interceptor runs, preferably in the
authentication middleware. It should be:

- unique for each logical API attempt;
- stable across an infrastructure retry of that same attempt; and
- generated by trusted server infrastructure.

The catalog policy appends each charge ID to the request ID. Reusing an ID with
different credit semantics is rejected. Replaying an already-created catalog
reservation or `dev` observation returns HTTP `409 Conflict` instead of running
the controller again.

When the resolver does not return a request ID, the SDK generates a UUID. That
keeps one execution safe but cannot deduplicate a later client retry.

## Grant credits

Grant plans only from trusted billing or payment infrastructure.

```ts
import {
  CreditAppType,
  CreditType,
  CreditService,
  CreditSubject,
} from '@hypersign-protocol/credit-middleware';

const subject: CreditSubject = {
  tenantId: 'tenant_1',
  appType: CreditAppType.CAVACH_API,
  appId: 'app:123',
  creditType: CreditType.API_CREDIT,
};

await creditService.grant({
  subject,
  planId: 'plan_01',
  amount: 100,
  criticalBalance: 40,
  grantedAt: Date.now(),
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
  referenceId: 'payment_txn_01',
  reason: 'credit_purchase',
});
```

`amount`, `grantedAt`, and `expiresAt` must be positive safe integers;
`criticalBalance` must be a non-negative safe integer. Timestamps use Unix epoch
milliseconds. `grantedAt` cannot be in the future, and a new plan cannot already
be expired.

Grant retries are idempotent only when the plan's wallet, amount, grant time,
expiry, and reference all match. Within one SDK Redis namespace:

- a `planId` belongs to only one wallet;
- a `referenceId` identifies only one plan; and
- reusing either identifier with different semantics is rejected.

Before the first grant, `getBalance(subject)` returns `null`. Paid requests fail
closed with HTTP `402 Payment Required`.

## Automatic HTTP charging

For each non-free catalog route, the interceptor:

1. resolves the trusted subject and per-request environment;
2. for `prod`, reserves every catalog charge;
3. for `dev`, records every catalog charge using the observation Lua transaction;
4. invokes the controller only after all actions succeed;
5. for `prod`, commits `IMMEDIATE` reservations and leaves `DEFERRED` reservations
   active after success; and
6. for `prod`, rolls back active reservations if execution or settlement fails.

If a route has multiple charges and a later reservation fails, the SDK rolls
back earlier reservations created during the same policy execution.

### FIFO example

```text
plan-old available  10
plan-new available  50
request cost        25

stored allocation:
  plan-old          10
  plan-new          15
```

Commit produces one event per allocation. Rollback restores each allocation to
its original plan only while the plan is still active. If the plan expires
while credit is reserved, rollback records the expired amount and does not
resurrect it. Commit remains valid after plan expiry because reservation-time
eligibility was already established.

### Early-return middleware

Middleware can terminate a response before the global interceptor runs. For a
catalog route released with `boundary: true`, install
`CreditBoundaryMiddleware` after trusted authentication and before any
early-return middleware:

```ts
consumer
  .apply(
    AuthenticationContextMiddleware,
    CreditBoundaryMiddleware,
    EarlyReturnMiddleware,
  )
  .forRoutes('*');
```

If the response ends before the interceptor claims the reservation, the
boundary rolls it back. Routes without `boundary: true` are unaffected.

## Deferred settlement

Use `CreditSettlementMode.DEFERRED` when another process determines the final
outcome.

```ts
import { CreditSettlementMode } from '@hypersign-protocol/credit-middleware';

const reservation = await creditService.reserve({
  subject,
  requestId: 'job_019',
  operation: 'GENERATE_REPORT',
  amount: 25,
  settlementMode: CreditSettlementMode.DEFERRED,
});

// Renew long-running work before reservation.expiresAt.
const newExpiry = await creditService.renew(
  reservation.reservationId,
  reservation.leaseToken,
);

// Apply exactly one final outcome.
await creditService.commit(reservation.reservationId);
// or:
await creditService.rollback(reservation.reservationId, 'job_failed');
```

`renew()` extends the reservation lease by `leaseMs`, increments its version,
and returns the new expiry. It does not extend the underlying plan expiry.

Set `autoRecover: false` only on a `CreditSettlementMode.DEFERRED` reservation
that must remain active until explicit settlement. The host then owns orphan
detection and settlement completely.

For a catalog-created deferred charge, use `getCreditRequestState()` to obtain
the reservation ID inside the controller:

```ts
import {
  CreditBillingMode,
  CreditSettlementMode,
  getCreditRequestState,
} from '@hypersign-protocol/credit-middleware';

const state = getCreditRequestState(request);
const action = state?.actions.find(
  ({ charge }) => charge.settlementMode === CreditSettlementMode.DEFERRED,
);
const reservationId = action?.billingMode === CreditBillingMode.ENFORCE
  ? action.reservation.reservationId
  : undefined;
```

## Recovery

The SDK does not start an interval or cron job. Invoke the stateless recovery
entry point from external scheduling infrastructure or a dedicated worker:

```ts
const processed = await creditRecoveryService.runOnce();
```

Each pass processes a bounded batch of:

- expired reservation leases with `autoRecover: true`; and
- expired, unused plan balances.

Choose the recovery cadence from the maximum acceptable delay after a lease or
plan expires. During a backlog, repeat passes until due work is drained.
Multiple processes may run recovery concurrently; Lua state transitions ensure
only one applies each transition. Overlapping calls on the same service
instance return `0` for the additional call.

A conventional Nest scheduler that runs every five minutes is:

```ts
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CreditRecoveryService } from '@hypersign-protocol/credit-middleware';

@Injectable()
export class CreditRecoveryScheduler {
  constructor(private readonly recovery: CreditRecoveryService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'credit-recovery',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    await this.recovery.runOnce();
  }
}
```

Import `ScheduleModule.forRoot()` once in the application and register this
class as a provider. `waitForCompletion` prevents overlapping cron invocations
inside one process; Redis Lua keeps multiple replicas safe.

## BullMQ transport

BullMQ transport is enabled by default. The SDK:

- relays the transactional Redis Stream outbox to lifecycle queues; and
- creates a worker for trusted credit commands.

No BullMQ provider or Stream Redis client is injected by the host. Configure
only names and relay tuning when the defaults are not suitable:

```ts
import { CreditServiceType } from '@hypersign-protocol/credit-middleware';

CreditModule.forRootAsync({
  imports: [CreditInfrastructureModule],
  useFactory: () => ({
    keyPrefix: 'hypersign-credit',
    redisHashTag: 'hypersign-credit',
    requestContextResolver: resolveCreditContext,
    transport: {
      lifecycleQueueNames: [
        'credit.lifecycle.reconciliation',
        'credit.lifecycle.notifications',
      ],
      commandQueueName: `credit.commands.${CreditServiceType.CAVACH_API}`,
    },
  }),
});
```

Use `transport: false` when this process should perform only synchronous credit
operations and another SDK process owns command ingestion and lifecycle relay.

The Stream entry is acknowledged only after every configured lifecycle queue
accepts the BullMQ job. Delivery is at least once: consumers must apply
`eventId` idempotently.

BullMQ workers on the same queue compete. Use separate queue names when
reconciliation, notifications, and analytics must each receive every event.

## Lifecycle events

Lifecycle jobs use this envelope:

```ts
interface CreditLifecycleEventEnvelope {
  eventId: string;
  schemaVersion: 3;
  catalogVersion: string;
  serviceType: string;
  event: Record<string, unknown>;
}
```

| Job name | Event type | Meaning |
| --- | --- | --- |
| `credit.granted` | `CREDIT_GRANTED` | A recharge plan was created. |
| `credit.plan-expired` | `PLAN_EXPIRED` | Unused plan credit expired. |
| `credit.plan-revoked` | `PLAN_REVOKED` | An explicit command revoked unused plan credit. |
| `credit.reserved` | `RESERVED` | Credit was allocated from one plan. |
| `credit.committed` | `COMMITTED` | One plan allocation was finalized. |
| `credit.rolled-back` | `ROLLED_BACK` | One allocation was processed as a rollback. |
| `credit.expired` | `EXPIRED` | Recovery processed an abandoned allocation. |
| `credit.critical-balance` | `CRITICAL_BALANCE` | Commit left a plan at or below its immutable threshold. |
| `credit.observed` | `CREDIT_OBSERVED` | A `dev` catalog charge was recorded with no deduction. |
| `credit.command-rejected` | n/a | An inbound command failed validation or execution. |

A reservation funded by multiple plans emits a separate reserved and
finalization event for each `planId`. Rollback/recovery events distinguish
`restoredAmount` from `expiredAmount`; consumers must not assume the full
allocation was restored.

Recommended downstream keys:

- delivery idempotency: envelope `eventId`;
- reconciliation: `reservationId + planId + event type`.

Persist the event receipt and its financial side effect in the same database
transaction before acknowledging the BullMQ job.

`CREDIT_OBSERVED` contains `environment: 'dev'`, `billingMode: 'OBSERVE'`,
`requestedAmount`, `deductedAmount: 0`, `requestId`, `operation`, and the scoped
subject. It has no `reservationId` or `planId` because no financial state was
created. Exact retries reuse the original observation and do not emit a second
event; conflicting reuse of the same request ID is rejected.

## Command messages

Trusted producers send schema-v3 envelopes to
`credit.commands.<serviceType>` by default:

```ts
interface CreditCommandEnvelope {
  commandId: string;
  schemaVersion: 3;
  serviceType: string;
  requestedAt?: string;
  source?: string;
  payload: Record<string, unknown>;
}
```

Use the originating business event ID for both `commandId` and BullMQ `jobId`.

### Grant command

Job name: `credit.grant.requested`

```ts
import {
  CreditAppType,
  CreditEventName,
  CreditServiceType,
  CreditType,
} from '@hypersign-protocol/credit-middleware';

await provider.add(
  `credit.commands.${CreditServiceType.CAVACH_API}`,
  CreditEventName.GRANT_REQUESTED,
  {
    schemaVersion: 3,
    commandId: payment.eventId,
    serviceType: CreditServiceType.CAVACH_API,
    source: 'payment-service',
    payload: {
      subject: {
        tenantId: 'tenant_1',
        appType: CreditAppType.CAVACH_API,
        appId: 'app:123',
        creditType: CreditType.API_CREDIT,
      },
      planId: payment.planId,
      amount: 100,
      criticalBalance: payment.criticalBalance,
      grantedAt: payment.createdAt.getTime(),
      expiresAt: payment.expiresAt.getTime(),
      referenceId: payment.transactionId,
      reason: 'credit_purchase',
    },
  },
  { jobId: payment.eventId },
);
```

If `referenceId` is absent, the command worker uses `commandId`.

### Revoke-plan command

Job name: `credit.plan-revoke.requested`

```ts
await provider.add(
  `credit.commands.${CreditServiceType.SSI_API}`,
  CreditEventName.PLAN_REVOKE_REQUESTED,
  {
    schemaVersion: 3,
    commandId: `${supportRequest.id}:${CreditType.BLOCKCHAIN_TXN_CREDIT}`,
    serviceType: CreditServiceType.SSI_API,
    source: 'developer-dashboard',
    payload: {
      subject: {
        tenantId,
        appType: CreditAppType.SSI_API,
        appId,
        creditType: CreditType.BLOCKCHAIN_TXN_CREDIT,
      },
      planId: `${planId}.${CreditType.BLOCKCHAIN_TXN_CREDIT}`,
      reason: supportRequest.reason,
    },
  },
  { jobId: `${supportRequest.id}:${CreditType.BLOCKCHAIN_TXN_CREDIT}` },
);
```

Send one command with a distinct `commandId`/`jobId` for each SDK plan
allocation that must be revoked. For SSI a
database plan can have separate `.API_CREDIT` and `.BLOCKCHAIN_TXN_CREDIT`
allocations. The SDK emits `credit.plan-revoked` only when it applies the state
transition; an exact retry returns `existing: true` without another event.
Credit already reserved before revocation can still commit. Rollback or lease
recovery finalizes that reservation without restoring revoked credit.

### Reserve command

Job name: `credit.reserve.requested`

Command-created reservations support only `DEFERRED` settlement.

```json
{
  "schemaVersion": 3,
  "commandId": "async-job-019",
  "serviceType": "CAVACH_API",
  "source": "workflow-service",
  "payload": {
    "subject": {
      "tenantId": "tenant_1",
      "appType": "CAVACH_API",
      "appId": "app:123",
      "creditType": "API_CREDIT"
    },
    "requestId": "async-job-019",
    "amount": 25,
    "operation": "GENERATE_REPORT",
    "settlementMode": "DEFERRED",
    "autoRecover": true
  }
}
```

### Settlement commands

Job names:

- `credit.commit.requested`
- `credit.rollback.requested`

```json
{
  "schemaVersion": 3,
  "commandId": "async-job-019:commit",
  "serviceType": "CAVACH_API",
  "payload": { "reservationId": "3db57c81-..." }
}
```

Rollback also accepts an optional `payload.reason`. Settlement returns
`APPLIED`, the existing reservation status, or `NOT_FOUND` as the BullMQ job
result.

Invalid commands publish `credit.command-rejected` when possible and then
throw, allowing the SDK's BullMQ retry policy to run.

## Service API reference

`CreditService` is injectable after `CreditModule` registration.

| Method | Behavior |
| --- | --- |
| `grant(input)` | Creates or exactly replays an immutable recharge plan. |
| `reserve(input)` | Atomically allocates credit and creates a leased reservation. |
| `observe(input)` | Atomically records `dev` usage without reading or mutating financial balances. |
| `commit(id)` | Commits an active reservation; returns `true` only when applied. |
| `rollback(id, reason?)` | Rolls back an active reservation; returns `true` only when applied. |
| `renew(id, leaseToken)` | Renews an active lease and returns the new expiry. |
| `getBalance(subject)` | Returns available unexpired credit, or `null` before any grant. |
| `getPlans(subject)` | Returns plans ordered by grant time and plan ID. |
| `getReservation(id)` | Returns retained reservation state or `null`. |
| `recoverExpired(now?)` | Recovers due auto-recoverable reservations. |
| `recoverExpiredPlans(now?)` | Expires due unused plan balances. |
| `revokePlan(input)` | Permanently removes one plan's unused credit and emits `PLAN_REVOKED`. |

### `GrantCreditsInput`

```ts
interface GrantCreditsInput {
  subject: CreditSubject;
  planId: string;
  amount: number;
  criticalBalance: number;
  grantedAt: number;
  expiresAt: number;
  referenceId: string;
  reason?: string;
}
```

### `ReserveCreditInput`

```ts
interface ReserveCreditInput {
  subject: CreditSubject;
  requestId?: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  operation?: string;
  autoRecover?: boolean;
  environment?: CreditEnvironment.PROD;
}
```

`settlementMode` defaults to `CreditSettlementMode.IMMEDIATE`; `autoRecover`
defaults to `true`. `autoRecover: false` requires
`CreditSettlementMode.DEFERRED`. Direct financial reserves default to `prod`
and reject any other environment.

### `ObserveCreditInput`

```ts
interface ObserveCreditInput {
  subject: CreditSubject;
  requestId?: string;
  amount: number;
  operation?: string;
  environment: CreditEnvironment.DEV;
}
```

### `ReserveCreditResult`

```ts
interface ReserveCreditResult {
  reservationId: string;
  leaseToken: string;
  scopeId: string;
  remainingBalance: number;
  expiresAt: number;
  autoRecover: boolean;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  existing: boolean;
  settlementMode: CreditSettlementMode;
  subject: CreditSubject;
  allocations: Array<{
    planId: string;
    amount: number;
    planBalanceAfter: number;
  }>;
}
```

### Plan status

`getPlans()` returns `CreditPlanStatus.ACTIVE`, `.DEPLETED`, `.EXPIRED`, or
`.REVOKED`. Expired
plans are reported with zero available credit even before recovery persists
their expiry event. Each plan also returns its immutable `criticalBalance`.

### Reservation status

`getReservation()` returns `CreditReservationStatus.RESERVED`, `.COMMITTED`,
`.ROLLED_BACK`, or `.EXPIRED`.
Finalized reservation and request-id records are retained for `retentionMs`.

### Return-value idempotency

`commit()` and `rollback()` return `true` only when that call applies the state
transition. They return `false` for missing or already-finalized reservations.
Call `getReservation()` when a caller needs to distinguish those cases.

## Configuration reference

| Option | Default | Description |
| --- | --- | --- |
| `requestContextResolver` | compatibility fallback | Returns the trusted subject, optional request ID, and required lowercase per-request `prod`/`dev` environment. Override in production. |
| `leaseMs` | `60000` | Reservation lease duration in milliseconds. |
| `retentionMs` | `604800000` | Finalized reservation and request-record retention (7 days). |
| `recoveryBatchSize` | `100` | Maximum reservations and maximum plans processed per recovery pass. |
| `maxActivePlans` | `1000` | Maximum active FIFO plans for one wallet. |
| `maxPlanAllocationsPerReservation` | `100` | Maximum plans one reservation may span. |
| `terminalPlanRetentionCount` | `100` | Newest depleted, expired, or revoked plans retained in full per wallet. Unfinished plans are always retained. |
| `keyPrefix` | `credit` | Redis namespace prefix; braces are forbidden. |
| `redisHashTag` | `credit` | Shared Redis Cluster hash tag; braces are forbidden. |
| `eventStreamMaxLength` | `100000` | Approximate Redis Stream entry limit. |
| `transport` | enabled | SDK-owned lifecycle relay and command worker configuration, or `false`. |

BullMQ defaults:

| Option | Default |
| --- | --- |
| `prefix` | `bull` |
| `lifecycleQueueNames` | `['credit.lifecycle']` |
| `commandQueueName` | `credit.commands.<serviceType>` |
| `consumerGroup` | `credit-bull-relay:<serviceType>` |
| `batchSize` | `100` |
| `blockMs` | `5000` |
| `pendingIdleMs` | `30000` |

Durations, capacities, and batch sizes must be positive safe integers. Every
grant's `criticalBalance` must be a non-negative safe integer.

## Errors and HTTP behavior

| Status | Typical condition |
| --- | --- |
| `400 Bad Request` | Reused identity with different semantics, invalid grant state, or invalid boundary claim. |
| `401 Unauthorized` | A charged request lacks a trusted subject or valid lowercase `prod`/`dev` environment. |
| `402 Payment Required` | Unexpired plans cannot fund the complete charge. |
| `409 Conflict` | A catalog request ID already has a reservation or `dev` observation. |
| `500 Internal Server Error` | A request route is not cataloged or stored state is inconsistent. |
| `503 Service Unavailable` | Active-plan or allocation limit reached, or automatic commit could not apply. |

Configuration and catalog-audit errors throw during bootstrap. Do not catch and
ignore these failures.

## Production operations

### Redis baseline

- Enable TLS and authentication.
- Use AOF, replication, and tested backups.
- Set `maxmemory-policy noeviction`.
- Monitor latency, memory, persistence, replication lag, and failover.
- Capacity-plan the single Cluster slot used by the SDK hash tag.

All Lua keys intentionally share one Redis Cluster slot. For independent
scaling, deploy separate namespaces rather than splitting one namespace.

Never delete or edit individual SDK keys during an incident. Plans,
reservations, idempotency records, expiry indexes, and events cross-reference
one another.

### Required alerts

Alert on:

- HTTP `402`, `409`, and credit-policy `503` rates;
- recovery errors, due backlog, and repeated batch saturation;
- Stream pending depth and oldest pending age;
- relay shutdown or BullMQ add failures;
- `credit.command-rejected` events;
- wallets approaching `maxActivePlans`;
- reservations approaching lease expiry; and
- Redis memory, persistence, and replication health.

The relay automatically recreates a missing Stream consumer group. Other
non-recoverable relay failures stop its loop. Correct the dependency or
configuration failure and restart the host.

### Stream capacity

Set `eventStreamMaxLength` above peak event volume multiplied by the longest
credible relay outage. Stream trimming is approximate. An entry trimmed before
delivery cannot be reconstructed solely from BullMQ.

### Reconciliation

Regularly reconcile:

- payment transactions against immutable grant plans;
- plan totals, remaining amounts, and statuses;
- reservations against their allocation arrays;
- Stream IDs against downstream event receipts; and
- committed allocation events against the financial ledger.

Use envelope `eventId` for delivery idempotency. Retain
`reservationId + planId + event type` as a business reconciliation key.

### Incident response

1. Stop manual settlement and replay actions.
2. Preserve Redis, BullMQ, API, recovery-worker, and consumer logs.
3. Identify the namespace, subject, plan, reservation, request, command, and
   event IDs involved.
4. Read and reconcile state without modifying Redis keys.
5. Repair the failed transport or consumer and replay idempotently.
6. Resume recovery and verify convergence across all stores.

Never correct a balance with a direct Redis edit. Use a reviewed migration or
application-level financial operation that preserves the audit trail.

## Testing

### Local validation

```sh
npm ci
npm run build
npm test
npm run lint
```

Redis integration verification requires a reachable Redis instance:

```sh
REDIS_URL=redis://localhost:6379 npm run test:redis
```

### Application test matrix

Before production rollout, verify:

- free and charged catalog routes;
- missing and exhausted wallets;
- exact grant retries and conflicting identifier reuse;
- duplicate request IDs and retry behavior;
- controller success, synchronous failure, and Observable failure;
- multi-charge compensation;
- reservations spanning several FIFO plans;
- plan expiry during an active reservation;
- deferred renewal, commit, rollback, and orphan recovery;
- concurrent reserve and recovery workers;
- Stream/BullMQ outage and replay;
- duplicate lifecycle delivery; and
- route-audit failure during an intentional catalog mismatch.

## Upgrade notes

Version 5 stores Redis state under:

```text
<keyPrefix>:v2:{<redisHashTag>}:...
```

It does not read version 3 aggregate-balance keys. Moving from v3 requires an
explicit migration or an isolated namespace whose grants are rebuilt from the
financial system of record.

Before rollback, confirm the target SDK understands the existing key schema,
catalog, and event schema. Do not point incompatible SDK versions at the same
namespace.

## Related technical references

- [End-to-end technical architecture](technical-architecture.md)
- [Redis keyspace and stored records](redis-keyspace.md)
- [Lua state transitions](lua-scripts.md)
- [Integration examples](../example/README.md)
- [Grant and lifecycle example](../example/event-server/README.md)
