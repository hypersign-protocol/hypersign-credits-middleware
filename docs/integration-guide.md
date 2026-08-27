# Integration guide

This is the complete integration procedure for the API server and the
credit-management server. Follow the steps in order.

> SDK version: `5.0.0`  
> Service type: `CreditServiceType.CAVACH_API` (`CAVACH_API` on the wire)  
> Credit type: `CreditType.API_CREDIT` (`API_CREDIT` on the wire)

`CreditServiceType.CAVACH_API` identifies the catalog and message transport.
`CreditAppType.CAVACH_API` identifies the `subject.appType` wallet dimension.
They currently serialize to the same text, but they are used in different
fields and are not interchangeable.

Use SDK enums for protocol values:

| Meaning | TypeScript | Stored or transmitted value |
| --- | --- | --- |
| Production request | `CreditEnvironment.PROD` | `prod` |
| Development request | `CreditEnvironment.DEV` | `dev` |
| Deduct credit | `CreditBillingMode.ENFORCE` | `ENFORCE` |
| Observe without deduction | `CreditBillingMode.OBSERVE` | `OBSERVE` |
| Immediate settlement | `CreditSettlementMode.IMMEDIATE` | `IMMEDIATE` |
| Deferred settlement | `CreditSettlementMode.DEFERRED` | `DEFERRED` |

Environment matching is strict. Uppercase `PROD` and `DEV` are invalid input;
authentication must supply lowercase `prod` or `dev`.

## Step 1: understand the two servers

The integration has two application roles:

| Server | Responsibilities |
| --- | --- |
| API server | Authenticates API calls, provides the request wallet and environment, imports `CreditModule`, runs five-minute recovery, deducts `prod` credit, and records `dev` usage without deduction. The SDK's internal worker consumes credit commands. |
| Credit-management server | Creates plans after payment or onboarding, publishes grant commands, consumes lifecycle events, and stores plan and usage changes in the application database. The repository `example/event-server` shows this role. |

Both servers connect to the same Redis deployment and use the same BullMQ
prefix.

```text
credit-management server                         API server

publish plan grant
        |
        +---- credit.commands.CAVACH_API -----> SDK applies the grant
                                                       |
                                                prod/dev API calls
                                                       |
        <---------- credit.lifecycle -------- SDK lifecycle events

                    both use the same Redis
```

### Queues

| Queue | Producer | Consumer | Purpose |
| --- | --- | --- | --- |
| `credit.commands.CAVACH_API` | Credit-management server | SDK worker inside an API-server instance | Trusted plan, reservation, commit, and rollback commands. |
| `credit.lifecycle` | SDK | Credit-management server | Plan, usage, reservation, settlement, expiry, and rejection events. |

Do not create a command worker in the credit-management server. Do not create
a lifecycle worker in the API server. Workers attached to one BullMQ queue
compete for jobs.

### Command job names

| Job name | Action |
| --- | --- |
| `credit.grant.requested` | Add an immutable credit plan to a wallet. |
| `credit.reserve.requested` | Create a trusted deferred reservation. |
| `credit.commit.requested` | Commit a deferred reservation. |
| `credit.rollback.requested` | Roll back a deferred reservation. |

The standard HTTP integration only needs `credit.grant.requested`. The other
commands are for trusted asynchronous workflows.

### Lifecycle job names

| Job name | Meaning |
| --- | --- |
| `credit.granted` | A plan was added successfully. |
| `credit.reserved` | Credit was reserved from one plan. |
| `credit.committed` | Reserved credit became a permanent deduction. |
| `credit.rolled-back` | Reserved credit was returned after a failed request. |
| `credit.expired` | An abandoned reservation lease expired. |
| `credit.plan-expired` | Unused plan credit expired. |
| `credit.critical-balance` | A plan reached its configured critical threshold. |
| `credit.observed` | A `dev` request was recorded with zero deduction. |
| `credit.command-rejected` | A trusted command failed validation or execution. |

Lifecycle envelopes use `schemaVersion: 3` and
`serviceType: CreditServiceType.CAVACH_API`. Persist normal lifecycle
messages idempotently by envelope `eventId`. Rejection messages identify the
failed `commandId`.

The example grant endpoint is local infrastructure, not a public API.

## Step 2: confirm requirements

You need:

- Node.js 18 or newer;
- a NestJS 9–11 CAVACH API;
- Redis 6.2 or newer;
- authentication that can identify the application, tenant, and whether each
  request is `prod` or `dev`; and
- controllers that match the SDK's bundled CAVACH route catalog.

Before continuing, confirm:

- the API server already starts without this SDK;
- its authentication guard or middleware can provide `appId`, optional
  `subdomain`, and per-request `prod` or `dev`;
- the API server can reach Redis; and
- the SDK repository is checked out if you intend to run
  `example/event-server`.

At startup the SDK compares the complete NestJS route table with its bundled
catalog. A partial test API fails this audit.

## Step 3: install the API-server dependencies

Run in the API server:

```sh
npm install @hypersign-protocol/credit-middleware ioredis @nestjs/schedule
```

BullMQ is already included by the SDK. Do not pass a BullMQ provider or Redis
Stream client into `CreditModule`.

## Step 4: provide the Redis connection

Configure the API server:

```dotenv
REDIS_URL=redis://username:password@redis-host:6379/0
```

Local Redis:

```dotenv
REDIS_URL=redis://localhost:6379/0
```

Confirm Redis is reachable before starting either server:

```sh
redis-cli -u 'redis://localhost:6379/0' PING
```

Expected response:

```text
PONG
```

Create `src/credit/credit-infrastructure.module.ts`:

```ts
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
class CreditRedisShutdown implements OnApplicationShutdown {
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
        if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
        const redis = new Redis(process.env.REDIS_URL, {
          enableReadyCheck: true,
          maxRetriesPerRequest: 2,
        });
        await redis.ping();
        return redis;
      },
    },
    CreditRedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class CreditInfrastructureModule {}
```

Do not set ioredis's `keyPrefix`. The SDK manages its own Redis key namespace.

## Step 5: add five-minute recovery

Create `src/credit/credit-recovery.scheduler.ts`. Recovery finalizes abandoned
reservations and expires unused plan credit.

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

`waitForCompletion` prevents overlapping runs inside one process. SDK Redis
operations also make multiple application instances safe.

## Step 6: register the SDK

Create `src/credit/credit-integration.module.ts`:

```ts
import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CreditAppType,
  CreditEnvironment,
  CreditModule,
  CreditType,
} from '@hypersign-protocol/credit-middleware';
import { CreditInfrastructureModule } from './credit-infrastructure.module';
import { CreditRecoveryScheduler } from './credit-recovery.scheduler';

interface TrustedServiceRequest {
  service?: {
    appId?: string;
    subdomain?: string;
    env?: string;
  };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    CreditInfrastructureModule,
    CreditModule.forRootAsync({
      imports: [CreditInfrastructureModule],
      useFactory: () => ({
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as TrustedServiceRequest;
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
    }),
  ],
  providers: [CreditRecoveryScheduler],
  exports: [CreditModule],
})
export class CreditIntegrationModule {}
```

Import `CreditIntegrationModule` once in the root `AppModule`:

```ts
import { Module } from '@nestjs/common';
import { CreditIntegrationModule } from './credit/credit-integration.module';

@Module({
  imports: [
    CreditIntegrationModule,
    // Keep the application's existing modules here.
  ],
})
export class AppModule {}
```

Call `ScheduleModule.forRoot()` once. Reuse an existing registration.

The SDK supplies defaults for `leaseMs`, `retentionMs`, queues, Stream settings,
and recovery batch size.

## Step 7: provide trusted identity for every request

Before the credit interceptor runs, authentication must set the service values.
A stable request ID is recommended when your gateway already creates one:

```ts
request.service = {
  appId: verifiedApplication.appId,
  subdomain: verifiedApplication.subdomain,
  env: verifiedApiCall.environment, // exactly prod or dev
};
request.requestId = trustedRequestId; // optional; the SDK generates one if absent
```

Derive these values from a verified API key, token, or service record. Do not
accept them from an unauthenticated body, query parameter, or header.

Environment is per request:

| Environment | Result |
| --- | --- |
| `prod` (`CreditEnvironment.PROD`) | The SDK reserves and deducts the catalog price. |
| `dev` (`CreditEnvironment.DEV`) | The SDK emits `CREDIT_OBSERVED` with zero deduction. |
| Missing or another value | The SDK rejects the request before the controller runs. |

The resolver selects this wallet:

```ts
{
  tenantId: request.service.subdomain,
  appId: request.service.appId,
  appType: CreditAppType.CAVACH_API,
  creditType: CreditType.API_CREDIT
}
```

Plan grants must match all four fields, including case.

## Step 8: configure NestJS routing

In `main.ts`, keep the global prefix and URI versioning expected by the bundled
catalog:

```ts
import { VersioningType } from '@nestjs/common';

app.setGlobalPrefix('api');
app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: '1',
});
app.enableShutdownHooks();
```

Start the API. A catalog mismatch is a deployment error; fix the routes or use
a compatible SDK release.

For a standard NestJS project:

```sh
export REDIS_URL=redis://localhost:6379/0
npm run start:dev
```

Use the API application's existing start command if it differs.

Successful startup includes a log in this form:

```text
[CreditCatalogAuditor] Validated <route-count> route(s) against credit catalog CAVACH_API@3.21.1
```

Do not continue until the API server remains running and this audit succeeds.

## Step 9: start the credit-management example and grant a plan

In a second terminal, start the event server from the SDK repository:

```sh
npm install
export REDIS_URL=redis://localhost:6379/0
npm run start:example:events
```

The event server is repository-only and is not shipped in the npm package.

Expected startup message:

```text
Credit event server listening on http://localhost:3002
```

Its files have these responsibilities:

| File | Responsibility |
| --- | --- |
| `example/event-server/credit-events.controller.ts` | Validates the grant request, sets SDK-owned fields, and publishes `credit.grant.requested`. |
| `example/event-server/lifecycle-consumer.service.ts` | Consumes and validates jobs from `credit.lifecycle`. |
| `example/event-server/event-store.service.ts` | Keeps recent events in memory for local verification. Replace this with database persistence. |
| `example/bullmq.module.ts` | Creates the external BullMQ producer and lifecycle worker. This provider is not passed into `CreditModule`. |

In a third terminal, create timestamps and send a grant:

```sh
GRANTED_AT=$(node -p 'Date.now()')
EXPIRES_AT=$(node -p 'Date.now() + 30 * 24 * 60 * 60 * 1000')

curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d "{
    \"tenantId\": \"tenant/acme\",
    \"appId\": \"app:123\",
    \"planId\": \"api-plan-001\",
    \"amount\": 1000,
    \"grantedAt\": ${GRANTED_AT},
    \"expiresAt\": ${EXPIRES_AT}
  }"
```

Set `tenantId` and `appId` to the values returned by the API resolver. The
endpoint does not accept `serviceType`, `appType`,
`creditType`, `referenceId`, or `criticalBalance`. The trusted server sets the
fixed types, generates internal IDs, and calculates the critical threshold as
40% of the granted amount.

The complete grant path is:

1. the example endpoint publishes `credit.grant.requested` to
   `credit.commands.CAVACH_API`;
2. one SDK worker in the API server validates and applies the grant;
3. the SDK writes `CREDIT_GRANTED` to its Redis outbox;
4. the SDK relay publishes `credit.granted` to `credit.lifecycle`; and
5. the credit-management worker persists the event.

The HTTP response has this shape:

```json
{
  "queued": true,
  "commandId": "grant-CAVACH_API-api-plan-001",
  "queue": "credit.commands.CAVACH_API",
  "planId": "api-plan-001",
  "referenceId": "example-grant-api-plan-001"
}
```

Confirm application of the grant:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

Do not send a paid API request until this response contains a
`credit.granted` job for `api-plan-001`. `"queued": true` confirms only
that BullMQ accepted the command.

## Step 10: verify prod and dev calls

Call one priced CAVACH route with a verified `prod` credential:

1. the controller runs;
2. the wallet balance decreases by the route's catalog price; and
3. `credit.reserved` and `credit.committed` lifecycle jobs appear.

Call the same route with a verified `dev` credential. The controller runs,
the balance is unchanged, and `credit.observed` appears.

Use an existing priced route and the API server's actual authentication format.
The URL, body, and credential cannot be generic because they belong to the host
application. The two calls must resolve the same `tenantId`, `appId`,
`appType`, and `creditType`; only the trusted environment changes.

Inspect events received by the example process:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

## Step 11: implement durable lifecycle handling

The repository event server keeps a bounded in-memory list for verification.
In the credit-management server, replace that store with a BullMQ worker that:

1. consumes `credit.lifecycle`;
2. validates the job name, `schemaVersion`, `serviceType`, and event type;
3. uses envelope `eventId` as the unique ID for lifecycle events, or
   `commandId` plus the job name for `credit.command-rejected`;
4. applies the plan, usage, or settlement update in the same database
   transaction; and
5. completes the BullMQ job only after the database transaction commits.

Throw when validation or persistence fails so BullMQ can retry. If analytics,
notifications, and reconciliation must each receive every lifecycle event,
give each system a separate lifecycle queue. Multiple workers on
`credit.lifecycle` divide the jobs between them.

## Acceptance checklist

- [ ] The API server starts without a catalog-audit error.
- [ ] The grant response contains `queued: true`.
- [ ] A `credit.granted` event appears.
- [ ] A `prod` request reduces the correct wallet balance.
- [ ] A `dev` request emits an observation and deducts zero.
- [ ] A second plan can be granted before the first is exhausted.
- [ ] Consumption continues from plan 1 into plan 2 using FIFO.
- [ ] Recovery runs every five minutes.
- [ ] Application shutdown closes Redis cleanly.

## Common integration problems

| Symptom | Check |
| --- | --- |
| API fails during startup | The controllers, global prefix, or URI versions do not match the bundled catalog. |
| HTTP 401 before the controller | Authentication did not attach trusted `appId`, tenant, or a valid lowercase `prod`/`dev` environment. |
| Grant is queued but balance stays zero | The grant wallet does not exactly match the request wallet, or both applications use different Redis servers. |
| HTTP 402 with another plan available externally | The plan exists in a database but was not successfully granted into SDK Redis. Look for `credit.granted` or `credit.command-rejected`. |
| `dev` request deducts credit | The trusted authentication result incorrectly classified the call as `prod`. |
| Duplicate event handling | Persist lifecycle events with a unique database constraint on envelope `eventId`. |

See the [developer reference](developer-guide.md) for configuration, event
schemas, Redis keys, and operations.
