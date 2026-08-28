# Redis keyspace

For command-to-event sequence diagrams and complete execution algorithms, see
the [technical architecture](technical-architecture.md).

Version 5 uses a versioned base:

```text
<keyPrefix>:v2:{<redisHashTag>}
```

The hash tag keeps every Lua key in one Redis Cluster slot. Version `v2`
prevents legacy aggregate balances from being interpreted as plan state.

The bundled defaults are:

```text
keyPrefix:    credit
redisHashTag: credit
base:         credit:v2:{credit}
```

Changing `keyPrefix` or `redisHashTag` selects another financial namespace; it
does not rename existing data. Treat either change as a data migration.

Wallet scope is derived from:

```text
tenantId, appType, appId, creditType
```

Each dimension records whether it is absent and URI-encodes its value. The
service type is transport identity and is not part of wallet scope.

## Deterministic construction

The scope uses this fixed dimension order and presence-marker format:

```text
tenant=<encoded>|appType=<encoded>|app=<encoded>|creditType=<encoded>
```

`<encoded>` is `0` for an absent or trimmed-empty optional value and
`1:<encodeURIComponent(value)>` for a present value. `appId` is required.
Values are trimmed and case-sensitive.

For example:

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

produces:

```text
tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
```

This value is an identifier, not encrypted data. Redis key enumeration can
expose encoded account metadata and must be access-controlled.

`planId`, `referenceId`, `requestId`, and `reservationId` are URI-encoded when
used in keys. The versioned base and scope make key generation identical across
API instances and recovery workers.

All concrete examples in this document use:

```text
tenantId        tenant/acme
appType         CAVACH_API
appId           app:123
creditType      API_CREDIT
planId          plan/2026/001
referenceId     payment/stripe/pi_001
requestId       req/019:api
reservationId   3db57c81-0000-4000-8000-000000000000
```

The resulting scope is:

```text
tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
```

The transport `serviceType` is not implicitly part of wallet scope. Here,
`CAVACH_API` appears only because the host also supplied it as `subject.appType`.

## Complete SDK-owned key catalogue

`<base>` means `<keyPrefix>:v2:{<redisHashTag>}` and `<scope>` means the entire
four-dimensional scope string shown above.

| Purpose | Exact pattern | Type | Stored value or member | Retention |
| --- | --- | --- | --- | --- |
| Cached aggregate | `<base>:balance:<scope>` | String | Non-negative available wallet total | Persistent |
| FIFO active plans | `<base>:plans:order:<scope>` | Sorted set | Member `planId`; score `grantedAt` in epoch ms | Depleted/expired members are removed |
| Original amount | `<base>:plans:amount:<scope>` | Hash | `planId -> granted amount` | Unfinished plans plus newest terminal plans |
| Available amount | `<base>:plans:remaining:<scope>` | Hash | `planId -> currently available amount` | Unfinished plans plus newest terminal plans |
| Expiry | `<base>:plans:expires:<scope>` | Hash | `planId -> expiresAt` in epoch ms | Unfinished plans plus newest terminal plans |
| Grant time | `<base>:plans:granted-at:<scope>` | Hash | `planId -> grantedAt` in epoch ms | Unfinished plans plus newest terminal plans |
| Business reference | `<base>:plans:reference:<scope>` | Hash | `planId -> referenceId` | Unfinished plans plus newest terminal plans |
| Plan status | `<base>:plans:status:<scope>` | Hash | `planId -> ACTIVE, DEPLETED, EXPIRED, or REVOKED` | Unfinished plans plus newest terminal plans |
| Critical balance | `<base>:plans:critical-balance:<scope>` | Hash | `planId -> immutable threshold` | Unfinished plans plus newest terminal plans |
| Expiration member | `<base>:plans:expiration-member:<scope>` | Hash | `planId -> JSON member used by the global expiry index` | Unfinished plans plus newest terminal plans |
| In-flight plan references | `<base>:plans:inflight:<scope>` | Hash | `planId -> active reservation count` | Removed with safely compacted plan metadata |
| SDK-v5 tracked plans | `<base>:plans:tracked:<scope>` | Hash | `planId -> 1` | Compatibility guard for automatic cleanup |
| Terminal plan order | `<base>:plans:terminal:<scope>` | Sorted set | Member `planId`; score terminal transition time | Newest `terminalPlanRetentionCount` kept in full |
| Global plan ownership | `<base>:plan-owner:<encoded-planId>` | Hash | Immutable `scopeId` and `referenceId` ownership | Persistent |
| Grant idempotency | `<base>:grant:<encoded-referenceId>` | Hash | Immutable plan and grant semantics | Persistent |
| Plan expiry index | `<base>:plan:expirations` | Sorted set | JSON member; score `expiresAt` in epoch ms | Member removed when handled/depleted |
| Reservation | `<base>:reservation:<encoded-reservationId>` | Hash | State, lease, subject, operation, and allocation JSON | TTL only after finalization |
| Request idempotency | `<base>:request:<scope>:<encoded-requestId>` | Hash | Request-to-reservation mapping and semantics | TTL only after finalization |
| `dev` observation | `<base>:observation:<scope>:<encoded-requestId>` | Hash | Event ID, amount, operation, and environment | `retentionMs` |
| Reservation expiry | `<base>:reservation:expirations` | Sorted set | Member `reservationId`; score lease expiry | Member removed when finalized |
| Transactional outbox | `<base>:events` | Stream | Credit lifecycle event fields | Approximate `eventStreamMaxLength` |

### Concrete example of every SDK-owned key

For the canonical values above, every key family becomes:

```text
# Wallet total
credit:v2:{credit}:balance:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT

# FIFO and per-plan hashes
credit:v2:{credit}:plans:order:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:amount:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:remaining:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:expires:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:granted-at:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:reference:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:status:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:critical-balance:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:expiration-member:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:inflight:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:tracked:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT
credit:v2:{credit}:plans:terminal:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT

# Global plan and grant identities
credit:v2:{credit}:plan-owner:plan%2F2026%2F001
credit:v2:{credit}:grant:payment%2Fstripe%2Fpi_001
credit:v2:{credit}:plan:expirations

# prod reservation and request idempotency
credit:v2:{credit}:reservation:3db57c81-0000-4000-8000-000000000000
credit:v2:{credit}:request:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT:req%2F019%3Aapi
credit:v2:{credit}:reservation:expirations

# dev observation idempotency (requestId: req/dev:api)
credit:v2:{credit}:observation:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT:req%2Fdev%3Aapi

# Transactional event outbox
credit:v2:{credit}:events
```

The plan-expiration sorted-set member for this example is a JSON value, not
another key:

```json
["app:123","tenant/acme","CAVACH_API","API_CREDIT","plan/2026/001"]
```

Do not URI-encode IDs before calling the SDK. Supply normal business values;
the SDK trims and encodes them exactly once.

The SDK keeps every unfinished plan and the newest 100 terminal plans per wallet
by default. Older depleted, expired, or revoked plan fields are removed only
when the SDK-maintained in-flight count is zero. `terminalPlanRetentionCount`
changes the full-history limit. Global plan ownership and grant idempotency
records remain persistent, so an old payment retry still cannot grant twice.

Only plans granted after this cleanup capability was installed are marked as
tracked. Pre-upgrade plans are left untouched because their older reservations
do not have reliable in-flight counters. This intentionally favors financial
correctness over an automatic migration.

`maxActivePlans` caps entries in the active FIFO sorted set. Depleted and
expired plans are removed from that set. `maxPlanAllocationsPerReservation`
limits one request's settlement fan-out.

## How to inspect a wallet safely

Use `SCAN`, never production `KEYS`, to discover keys. Quote every key because
scope IDs contain `|` and Redis Cluster keys contain braces.

```sh
redis-cli --scan --pattern 'credit:v2:{credit}:plans:*'
redis-cli --scan --pattern 'credit:v2:{credit}:reservation:*'
```

After deriving the exact scope, these read-only commands explain the wallet:

```sh
# Aggregate cached availability
redis-cli GET 'credit:v2:{credit}:balance:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT'

# Plans eligible for FIFO allocation, oldest first
redis-cli ZRANGE 'credit:v2:{credit}:plans:order:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT' 0 -1 WITHSCORES

# Per-plan availability, status, and expiry
redis-cli HGETALL 'credit:v2:{credit}:plans:remaining:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT'
redis-cli HGETALL 'credit:v2:{credit}:plans:status:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT'
redis-cli HGETALL 'credit:v2:{credit}:plans:expires:tenant=1:tenant%2Facme|appType=1:CAVACH_API|app=1:app%3A123|creditType=1:API_CREDIT'

# One reservation and recent outbox events
redis-cli HGETALL 'credit:v2:{credit}:reservation:3db57c81-0000-4000-8000-000000000000'
redis-cli XRANGE 'credit:v2:{credit}:events' - + COUNT 20

# Recovery indexes and epoch-millisecond scores
redis-cli ZRANGE 'credit:v2:{credit}:plan:expirations' 0 -1 WITHSCORES
redis-cli ZRANGE 'credit:v2:{credit}:reservation:expirations' 0 -1 WITHSCORES
```

These commands are for diagnosis only. Never use `SET`, `HSET`, `HDEL`, `DEL`,
`EXPIRE`, `ZADD`, or `ZREM` to repair financial state. Direct edits bypass the
Lua invariants and transactional event outbox.

### Diagnosing HTTP 402 before plan 2

The SDK allocates across all unexpired plans in the active FIFO sorted set, up
to `maxPlanAllocationsPerReservation`. It cannot consume a plan that exists
only in an external database or is still waiting in a BullMQ grant command.

Check in this order:

1. Confirm a `CREDIT_GRANTED` event exists for both plan IDs.
2. Confirm both plans use exactly the same `tenantId`, `appType`, `appId`, and
   `creditType`; one different dimension creates another wallet.
3. Confirm plan 2 is present in `plans:order:<scope>`.
4. Confirm its `plans:status` value is `ACTIVE` and `plans:remaining` is greater
   than zero.
5. Confirm `plans:expires` is later than the current epoch-millisecond time.
6. Confirm the combined eligible remainder covers the complete catalog charge.
   Reservations never partially deduct an unaffordable charge.
7. Check `credit.commands.CAVACH_API` failed jobs and
   `credit.command-rejected` events if the grant is absent.

`criticalBalance` is a notification threshold for one already granted plan. It
does not import or activate another plan. If an external plan manager waits for
`CRITICAL_BALANCE` before publishing plan 2, that asynchronous workflow can
race with the next paid request and cause a valid temporary 402. Register plan
2 with the SDK before traffic needs it; FIFO ordering prevents it from being
consumed before older available plans.

## Plan state

Statuses:

```text
ACTIVE -> DEPLETED
ACTIVE -> EXPIRED
DEPLETED -> ACTIVE       rollback before expiry
DEPLETED -> EXPIRED      expiry while reserved
ACTIVE/DEPLETED -> REVOKED (`credit.plan-revoke.requested`)
```

A grant creates all plan attributes, including its immutable low-balance
threshold, and the aggregate balance in one Lua call. The same call appends
`CREDIT_GRANTED`. Grant idempotency records are persistent; they must not expire
while a delayed BullMQ retry could reapply a payment.

## Reservation state

A reservation stores:

```text
reservationId, scopeId, appId, tenantId, appType, creditType,
requestId, total amount, aggregate balance after reservation,
status, leaseToken, createdAt, expiresAt, version,
settlementMode, operation, autoRecover, environment=prod, allocations JSON
```

Allocation JSON is an array of:

```json
{
  "planId": "plan-001",
  "amount": 10,
  "planBalanceAfter": 0
}
```

It is immutable. Settlement always uses this stored array.

Finalized reservation and request records receive `retentionMs`. Active records
have no TTL. Only `autoRecover=true` reservations are added to the reservation
expiry index.

## dev observation state

A `dev` catalog charge never creates a reservation and never reads or mutates
wallet or plan keys. One Lua transaction appends `CREDIT_OBSERVED` to the outbox
and stores this short idempotency hash:

```text
eventId, amount, operation, environment=dev
```

The hash receives `retentionMs`. An exact retry returns the original event ID
without appending another event; reuse with a different amount, operation, or
environment is rejected. Environment is deliberately absent from wallet scope,
so observation cannot create a parallel `dev` balance.

## Expiration indexes

Plan-expiration members encode subject dimensions plus `planId` as JSON. This
lets a stateless recovery worker reconstruct the exact scoped hashes.

The SDK creates no timer. `CreditRecoveryService.runOnce()` processes bounded
batches from both expiration indexes. Reservation and plan transitions remain
atomic if several workers run concurrently.

## Events and BullMQ keys

The Stream key is:

```text
<keyPrefix>:v2:{<redisHashTag>}:events
```

Every financial state transition appends its event in the same Lua call. The
relay acknowledges a Stream entry only after all configured BullMQ queues accept
it. BullMQ itself creates keys such as:

```text
bull:credit.lifecycle:*
bull:credit.commands.<serviceType>:*
```

With bundled `serviceType: CAVACH_API`, the concrete namespaces are:

```text
bull:credit.lifecycle:*
bull:credit.commands.CAVACH_API:*
```

Representative physical keys for every normal BullMQ role are:

| Role | Lifecycle example | Command example |
| --- | --- | --- |
| Waiting jobs | `bull:credit.lifecycle:wait` | `bull:credit.commands.CAVACH_API:wait` |
| Active jobs | `bull:credit.lifecycle:active` | `bull:credit.commands.CAVACH_API:active` |
| Delayed retries | `bull:credit.lifecycle:delayed` | `bull:credit.commands.CAVACH_API:delayed` |
| Completed jobs | `bull:credit.lifecycle:completed` | `bull:credit.commands.CAVACH_API:completed` |
| Failed jobs | `bull:credit.lifecycle:failed` | `bull:credit.commands.CAVACH_API:failed` |
| Queue event Stream | `bull:credit.lifecycle:events` | `bull:credit.commands.CAVACH_API:events` |
| Queue metadata | `bull:credit.lifecycle:meta` | `bull:credit.commands.CAVACH_API:meta` |
| ID counter | `bull:credit.lifecycle:id` | `bull:credit.commands.CAVACH_API:id` |
| Marker | `bull:credit.lifecycle:marker` | `bull:credit.commands.CAVACH_API:marker` |
| Individual job | `bull:credit.lifecycle:CAVACH_API-1787123456789-0` | `bull:credit.commands.CAVACH_API:grant-CAVACH_API-plan-001` |

BullMQ versions can add keys for stalled checks, priorities, repeat schedules,
dependencies, rate limits, and metrics. The `bull:<queueName>:*` namespace is
the stable pattern; individual internal suffixes are not an SDK contract.

These physical names use BullMQ's default `prefix: 'bull'`. The SDK's `keyPrefix` and
`redisHashTag` affect only SDK-owned state and Stream keys; they do not affect
BullMQ keys.

Typical BullMQ suffixes include `wait`, `active`, `delayed`, `completed`,
`failed`, `events`, `meta`, IDs, markers, and individual job records. They are
owned by BullMQ and must be accessed through BullMQ APIs rather than edited or
expired directly.

Default queue and relay identifiers are:

```text
lifecycle queue:       credit.lifecycle
command queue:         credit.commands.<serviceType>
Stream consumer group: credit-bull-relay:<serviceType>
```

For the bundled catalog these resolve to:

```text
lifecycle queue:       credit.lifecycle
command queue:         credit.commands.CAVACH_API
Stream consumer group: credit-bull-relay:CAVACH_API
Stream consumer name:  <process-id>-<random-UUID>
```

Lifecycle BullMQ job IDs are deterministic:

```text
<serviceType>-<redisStreamEventId>
```

A rejected command uses:

```text
<serviceType>-<commandId>-rejected
```

Inbound command job IDs are chosen by the trusted producer and should match the
stable `commandId`. BullMQ job-ID deduplication lasts only while the job record
is retained; lifecycle consumers still need a durable uniqueness constraint on
the envelope `eventId`.

Use AOF, replication, tested backups, and `noeviction`. Evicting a plan or
reservation independently can make a later rollback unrecoverable.
