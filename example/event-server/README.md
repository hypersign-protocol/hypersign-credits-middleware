# Grant and lifecycle event server

Example server for sending grant commands and receiving lifecycle events. It:

- publishes schema-v3 grants to `credit.commands.CAVACH_API`;
- consumes jobs from `credit.lifecycle`; and
- retains a bounded in-memory event list for local verification.

This server is excluded from the published npm package.

Use the [integration guide](../../docs/integration-guide.md) for the numbered
API-server and credit-management-server setup. This page documents the example
endpoint and process.

## Run

```sh
npm run start:example:events
```

The CAVACH API must contain the modules from [`example/host`](../host/README.md)
and use the same Redis and BullMQ configuration.

## Grant a plan

```sh
curl -X POST http://localhost:3002/credit-commands/grant \
  -H 'content-type: application/json' \
  -d '{
    "tenantId":"tenant/acme",
    "appId":"app:123",
    "planId":"api-plan-001",
    "amount":1000,
    "grantedAt":1780000000000,
    "expiresAt":1900000000000,
    "reason":"credit-purchase"
  }'
```

The endpoint accepts plan and wallet business data. It does not accept
`serviceType`, `appType`, `creditType`, `referenceId`, or
`criticalBalance`. The server:

- sets `serviceType` and `appType` to `CAVACH_API`;
- sets `creditType` to `API_CREDIT`;
- derives stable command and reference IDs from `planId`; and
- sets `criticalBalance` to `Math.floor(amount * 0.4)`.

Retrying an identical `planId` is idempotent. Changing an immutable grant
field for the same ID is rejected.

Grant another plan with a later `grantedAt` before the first is depleted. The
SDK consumes eligible plans by `grantedAt`, then `planId`. The grant wallet
must exactly match the API request wallet.

## Inspect lifecycle events

```sh
curl 'http://localhost:3002/credit-events?limit=25'
```

A `prod` request emits reservation and settlement events for each funding
plan. A `dev` request emits `credit.observed` with
`deductedAmount: 0` and does not change plan balances.

The in-memory event list is cleared on restart. A deployed consumer must
validate the envelope, persist the event receipt and financial effect in one
database transaction, enforce uniqueness on `eventId`, and throw on failure
so BullMQ retries the job. Workers on the same queue compete; independent
subscribers require separate lifecycle queues.

See the [integration guide](../../docs/integration-guide.md) for the complete
host and event-service flow.
