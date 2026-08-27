# NestJS host example

Example modules for registering the SDK in a NestJS application.

Use the [integration guide](../../docs/integration-guide.md) for the numbered
setup and verification procedure. This page documents the example files.

| Repository file | Host path | Responsibility |
| --- | --- | --- |
| `credit-infrastructure.module.ts` | `src/credit/credit-infrastructure.module.ts` | Provides and closes the Redis operation client. |
| `credit-integration.module.ts` | `src/credit/credit-integration.module.ts` | Registers the SDK and resolves request identity. |
| `credit-recovery.scheduler.ts` | `src/credit/credit-recovery.scheduler.ts` | Runs recovery every five minutes. |

## Install

```sh
npm install @hypersign-protocol/credit-middleware ioredis @nestjs/schedule
```

BullMQ is an SDK dependency. Do not register a BullMQ provider or Redis Stream
client for `CreditModule`.

## Configure Redis

```dotenv
REDIS_URL=redis://username:password@redis-host:6379/0
```

The API and external grant/lifecycle service must use the same Redis deployment
and BullMQ prefix. Do not set ioredis `keyPrefix`; the SDK owns its key
namespaces.

## Copy and register the modules

Copy the three files listed above and replace their repository-relative
`../../src` imports with
`@hypersign-protocol/credit-middleware`. Import
`CreditIntegrationModule` once in the root application module.

If scheduling is already initialized, keep one
`ScheduleModule.forRoot()` registration and reuse it.

The application routing must remain compatible with the bundled catalog:

```ts
app.setGlobalPrefix('api');
app.enableVersioning({
  type: VersioningType.URI,
  defaultVersion: '1',
});
app.enableShutdownHooks();
```

A route-audit failure indicates an incompatible controller or catalog release.

## Supply trusted request identity

Authentication must populate the request before the credit interceptor runs:

```ts
request.service = {
  appId: verifiedApplication.appId,
  subdomain: verifiedApplication.subdomain,
  env: verifiedApiCall.environment, // CreditEnvironment.PROD or .DEV
};
request.requestId = trustedRequestId; // optional
```

Derive these values from a verified credential or service record. Request
bodies, query parameters, and unauthenticated headers are not trusted sources.

The example resolves this wallet:

```ts
{
  tenantId: request.service.subdomain,
  appId: request.service.appId,
  appType: CreditAppType.CAVACH_API,
  creditType: CreditType.API_CREDIT
}
```

Every grant must match all four fields. Values are case-sensitive. The
environment is per request:

| Value | Result |
| --- | --- |
| `CreditEnvironment.PROD` (`prod`) | Enforce the catalog charge. |
| `CreditEnvironment.DEV` (`dev`) | Emit `CREDIT_OBSERVED` and deduct zero. |
| Missing or invalid | Reject before controller execution. |

The SDK generates a request ID when trusted infrastructure does not provide
one.

## Start the external service

From the SDK repository:

```sh
npm run start:example:events
```

Follow the [event-server reference](../event-server/README.md) to grant plans.
The example endpoint sets the fixed service, application, and credit types,
generates internal identifiers, and calculates the critical threshold as 40%
of the grant amount.

## Verify

- The API starts without a route-audit error.
- A grant produces `credit.granted`.
- A `prod` request produces `credit.reserved` and `credit.committed` and
  reduces the wallet balance.
- A `dev` request produces `credit.observed` with
  `deductedAmount: 0`.
- Two active plans are consumed FIFO without a premature HTTP 402.
- Recovery runs every five minutes.
- Shutdown closes the supplied Redis client and SDK-owned connections.

Inspect events from the repository process:

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

## Deployment requirements

Replace the example event store with durable, transactional persistence.
Enforce a unique constraint on envelope `eventId`, and fail the BullMQ job
when persistence fails so delivery can retry. Separate consumers that each
need every event must use separate lifecycle queues.

For the complete setup, see the
[integration guide](../../docs/integration-guide.md). For Redis diagnosis, see
the [keyspace reference](../../docs/redis-keyspace.md).
