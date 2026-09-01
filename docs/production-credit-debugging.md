# Production credit debugging runbook

This runbook is for tracing SSI and KYC credit state without changing it. It
assumes the SDK uses the default Redis base `credit:v2:{credit}` and BullMQ
prefix `bull`. If a deployment overrides either value, use the deployed value.

## Safety rules

Production diagnosis must be read-only.

Safe Redis commands include `SCAN`, `GET`, `TYPE`, `HGET`, `HGETALL`, `HMGET`,
`ZRANGE`, `ZSCORE`, `LRANGE`, `LLEN`, `XLEN`, `XRANGE`, `XREVRANGE`, `XINFO`,
and `XPENDING`.

Do not use these commands during diagnosis:

```text
SET HSET HDEL DEL UNLINK EXPIRE PERSIST
ZADD ZREM XADD XACK XDEL XTRIM
FLUSHDB FLUSHALL
```

Do not retry, promote, remove, or move a BullMQ job until its Redis transition
and lifecycle event have been identified. Do not use `rabbitmqadmin get` to
inspect a queue: fetching a message changes queue state or ordering even when
it is requeued.

Never print database, Redis, RabbitMQ, wallet, or mnemonic secrets. The MongoDB
examples below use the connection already present inside the dashboard pod and
do not print it.

## What to collect first

For one investigation, collect as many of these identifiers as possible:

```text
service/app ID
tenant ID
service type and app type (for example SSI_API)
credit type (API_CREDIT or BLOCKCHAIN_TXN_CREDIT)
base plan ID
reservation ID
request ID
SDK Stream event ID
BullMQ job ID
blockchain transaction hash
time range, including timezone
```

An SDK wallet is not identified by app ID alone. Its identity is:

```text
tenantId + appType + appId + creditType
```

A different tenant, app type, or credit type is a different Redis wallet.
`serviceType` selects transport/catalog behavior; it is not a Redis wallet
dimension.

## Set investigation variables

Use explicit pod names from the current deployment. Do not automate selection
when several rollouts are present.

```sh
kubectl config current-context
kubectl get pods -n hypermine-development -o wide

export DBG_NAMESPACE='hypermine-development'
export DBG_REDIS_POD='redis-stack-REPLACE_ME'
export DBG_ENTITY_POD='entity-api-REPLACE_ME'
export DBG_DASHBOARD_POD='developer-dashboard-backend-app-REPLACE_ME'
export DBG_TXN_CONTROLLER_POD='txn-processor-controller-REPLACE_ME'
export DBG_RABBIT_POD='rabbitmq-REPLACE_ME'

export DBG_APP_ID='REPLACE_WITH_SERVICE_ID'
export DBG_TENANT_ID='REPLACE_WITH_TENANT_ID'
export DBG_PLAN_ID='REPLACE_WITH_BASE_PLAN_ID'
export DBG_RESERVATION_ID='REPLACE_WITH_RESERVATION_ID'
```

The namespace name is not proof that a cluster is development or production.
Always verify the current Kubernetes context with the operator.

## System path

For a deferred SSI blockchain operation, the normal path is:

```text
dashboard grant command
  -> BullMQ credit.commands.SSI_API
  -> SDK Redis grant + CREDIT_GRANTED outbox event
  -> BullMQ credit.lifecycle
  -> dashboard plan/ledger update

HTTP request
  -> SDK reservation in Redis
  -> SSI transaction BullMQ job carrying reservation ID
  -> transaction processor result
  -> RabbitMQ developer-dashboard.ssi.txn-results
  -> dashboard commit/rollback command
  -> BullMQ credit.commands.SSI_API
  -> SDK commit/rollback + lifecycle event
  -> dashboard ledger/plan update
```

The checkpoint immediately before the first missing checkpoint usually owns
the problem.

## 1. Find the Redis wallet scope

Use `SCAN`; never use `KEYS` in production.

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --scan --pattern "*${DBG_APP_ID}*"
```

The result reveals the exact encoded scope, including the tenant and app type.
For a normal SSI wallet, define both credit scopes:

```sh
export DBG_API_SCOPE="tenant=1:${DBG_TENANT_ID}|appType=1:SSI_API|app=1:${DBG_APP_ID}|creditType=1:API_CREDIT"
export DBG_CHAIN_SCOPE="tenant=1:${DBG_TENANT_ID}|appType=1:SSI_API|app=1:${DBG_APP_ID}|creditType=1:BLOCKCHAIN_TXN_CREDIT"

export DBG_API_PLAN="${DBG_PLAN_ID}.API_CREDIT"
export DBG_CHAIN_PLAN="${DBG_PLAN_ID}.BLOCKCHAIN_TXN_CREDIT"
```

For KYC/Cavach, use `appType=1:CAVACH_API`, `creditType=1:API_CREDIT`, and
command queue `credit.commands.CAVACH_API`. KYC does not use the SSI
blockchain-credit scope unless that service has explicitly been configured to
make a separately billed SSI call.

If the app or tenant contains reserved URI characters, copy the scope from an
existing key or apply `encodeURIComponent` to each present value. Do not encode
the entire scope as one string.

No matching keys can mean:

- the grant has not reached the SDK;
- the wrong Redis deployment is being inspected;
- the request used another tenant, app type, or app ID; or
- all that remains is transport history rather than a wallet.

## 2. Inspect API and blockchain balances

Aggregate wallet balances:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw GET "credit:v2:{credit}:balance:${DBG_API_SCOPE}"

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw GET "credit:v2:{credit}:balance:${DBG_CHAIN_SCOPE}"
```

Active FIFO plans, oldest first:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw ZRANGE "credit:v2:{credit}:plans:order:${DBG_API_SCOPE}" 0 -1 WITHSCORES

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw ZRANGE "credit:v2:{credit}:plans:order:${DBG_CHAIN_SCOPE}" 0 -1 WITHSCORES
```

All plan amounts, remaining amounts, statuses, and expirations:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:amount:${DBG_API_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:remaining:${DBG_API_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:status:${DBG_API_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:expires:${DBG_API_SCOPE}"

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:amount:${DBG_CHAIN_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:remaining:${DBG_CHAIN_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:status:${DBG_CHAIN_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:expires:${DBG_CHAIN_SCOPE}"
```

One exact plan:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGET "credit:v2:{credit}:plans:remaining:${DBG_API_SCOPE}" "$DBG_API_PLAN"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGET "credit:v2:{credit}:plans:status:${DBG_API_SCOPE}" "$DBG_API_PLAN"

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGET "credit:v2:{credit}:plans:remaining:${DBG_CHAIN_SCOPE}" "$DBG_CHAIN_PLAN"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGET "credit:v2:{credit}:plans:status:${DBG_CHAIN_SCOPE}" "$DBG_CHAIN_PLAN"
```

For each wallet, the aggregate balance should equal the sum of remaining
amounts for eligible active plans. A base dashboard plan normally appears in
SSI Redis as two distinct IDs:

```text
<base-plan-id>.API_CREDIT
<base-plan-id>.BLOCKCHAIN_TXN_CREDIT
```

This suffix is intentional: the two balances are separate SDK wallets while
the dashboard still owns one base plan.

## 3. Check reservations and in-flight plan counts

Inspect one reservation:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:reservation:${DBG_RESERVATION_ID}"
```

Check whether either plan has active reservation references:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:inflight:${DBG_API_SCOPE}"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HGETALL "credit:v2:{credit}:plans:inflight:${DBG_CHAIN_SCOPE}"
```

Check the recovery index and the reservation's lease score:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw ZSCORE 'credit:v2:{credit}:reservation:expirations' "$DBG_RESERVATION_ID"
```

Interpretation:

- `RESERVED` before lease expiry can be normal deferred work.
- `RESERVED` well after lease expiry, still present in the expiration index,
  points to recovery not running or failing.
- `COMMITTED`, `ROLLED_BACK`, or `EXPIRED` is terminal. The reservation key is
  retained only for its configured finalization TTL.
- No reservation key plus no lifecycle evidence requires checking the request
  idempotency key and logs; do not recreate the reservation manually.

## 4. Inspect the SDK transactional outbox

The Redis Stream is the durable handoff between an SDK state transition and
BullMQ lifecycle delivery.

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli XLEN 'credit:v2:{credit}:events'

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli XINFO GROUPS 'credit:v2:{credit}:events'

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli XPENDING 'credit:v2:{credit}:events' 'credit-bull-relay:SSI_API'
```

Read the newest events and filter locally:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw XREVRANGE 'credit:v2:{credit}:events' + - COUNT 200 \
  | rg -C 20 --fixed-strings "$DBG_APP_ID"
```

Read one exact Stream event when its ID is known:

```sh
export DBG_EVENT_ID='REPLACE_WITH_STREAM_EVENT_ID'
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw XRANGE 'credit:v2:{credit}:events' "$DBG_EVENT_ID" "$DBG_EVENT_ID"
```

Important event fields include `event`, `reservationId`, `planId`, `amount`,
`planBalanceAfter`, `balanceAfter`, `operation`, `serviceType`, and `subject`.
For split allocations, several events can share one reservation ID.

A transition present in this Stream but absent from BullMQ points to the SDK
relay. A transition absent from the Stream did not complete its Redis Lua
operation.

## 5. Inspect BullMQ without changing jobs

Default SSI queues:

```sh
export DBG_COMMAND_QUEUE='credit.commands.SSI_API'
export DBG_LIFECYCLE_QUEUE='credit.lifecycle'
```

Queue counts:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LLEN "bull:${DBG_COMMAND_QUEUE}:wait"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LLEN "bull:${DBG_COMMAND_QUEUE}:active"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZCARD "bull:${DBG_COMMAND_QUEUE}:delayed"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZCARD "bull:${DBG_COMMAND_QUEUE}:failed"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZCARD "bull:${DBG_COMMAND_QUEUE}:completed"

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LLEN "bull:${DBG_LIFECYCLE_QUEUE}:wait"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LLEN "bull:${DBG_LIFECYCLE_QUEUE}:active"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZCARD "bull:${DBG_LIFECYCLE_QUEUE}:delayed"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZCARD "bull:${DBG_LIFECYCLE_QUEUE}:failed"
```

Find a known job in each state:

```sh
export DBG_JOB_ID='REPLACE_WITH_BULLMQ_JOB_ID'

kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LPOS "bull:${DBG_COMMAND_QUEUE}:wait" "$DBG_JOB_ID"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli LPOS "bull:${DBG_COMMAND_QUEUE}:active" "$DBG_JOB_ID"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZSCORE "bull:${DBG_COMMAND_QUEUE}:delayed" "$DBG_JOB_ID"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZSCORE "bull:${DBG_COMMAND_QUEUE}:failed" "$DBG_JOB_ID"
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli ZSCORE "bull:${DBG_COMMAND_QUEUE}:completed" "$DBG_JOB_ID"
```

Inspect safe job metadata. `data` and stack traces are deliberately omitted
because they can contain customer payloads:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_REDIS_POD" -- \
  redis-cli --raw HMGET "bull:${DBG_COMMAND_QUEUE}:${DBG_JOB_ID}" \
  name attemptsMade atm attemptsStarted ats timestamp processedOn finishedOn failedReason delay
```

For a lifecycle event, the default deterministic job ID is:

```text
<serviceType>-<redis-stream-event-id>
```

For example, `SSI_API-1788110377734-0`. A deterministic job ID prevents a
duplicate while that BullMQ job record exists. It does not replace SDK grant
idempotency or dashboard ledger idempotency.

Completed and failed job records are retained only up to the configured BullMQ
limits. A missing old job does not prove it never ran; use the SDK Stream,
ledger, and logs for durable correlation.

Do not decode BullMQ delayed-set scores as plain timestamps; BullMQ encodes
ordering data in the score. Use job fields and worker logs to determine retry
timing.

## 6. Trace Kubernetes logs

Search by reservation ID first because it connects the API request,
transaction processor result, and commit or rollback.

```sh
kubectl logs -n "$DBG_NAMESPACE" "$DBG_ENTITY_POD" --since=2h \
  | rg -C 10 --fixed-strings "$DBG_RESERVATION_ID"

kubectl logs -n "$DBG_NAMESPACE" "$DBG_TXN_CONTROLLER_POD" --since=2h \
  | rg -C 10 --fixed-strings "$DBG_RESERVATION_ID"

kubectl logs -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" --since=2h \
  | rg -C 10 --fixed-strings "$DBG_RESERVATION_ID"
```

Search by plan or app ID for grant activation:

```sh
kubectl logs -n "$DBG_NAMESPACE" "$DBG_ENTITY_POD" --since=2h \
  | rg -C 10 --fixed-strings "$DBG_PLAN_ID"

kubectl logs -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" --since=2h \
  | rg -C 10 --fixed-strings "$DBG_APP_ID"
```

If a pod restarted, inspect its previous container:

```sh
kubectl logs -n "$DBG_NAMESPACE" "$DBG_ENTITY_POD" --previous --tail=2000
kubectl logs -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" --previous --tail=2000
```

If transaction processors run as Kubernetes Jobs, locate the job created near
the request time and then read its log:

```sh
kubectl get jobs -n "$DBG_NAMESPACE" --sort-by=.metadata.creationTimestamp
kubectl get pods -n "$DBG_NAMESPACE" --sort-by=.metadata.creationTimestamp
kubectl logs -n "$DBG_NAMESPACE" job/REPLACE_WITH_TXN_PROCESSOR_JOB --tail=2000
```

When several replicas exist, search the deployment rather than one pod:

```sh
kubectl logs -n "$DBG_NAMESPACE" deployment/entity-api --all-pods=true --since=2h \
  | rg -C 10 --fixed-strings "$DBG_RESERVATION_ID"
```

NestJS timestamps, Kubernetes client timestamps, MongoDB dates, and blockchain
timestamps may use different timezones. Prefer event IDs, reservation IDs, and
epoch milliseconds over visual timestamp comparison.

## 7. Inspect RabbitMQ delivery

Queue inspection is read-only with `rabbitmqctl list_queues`:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_RABBIT_POD" -- \
  rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers

kubectl exec -n "$DBG_NAMESPACE" "$DBG_RABBIT_POD" -- \
  rabbitmqctl list_bindings source_name destination_name destination_kind routing_key
```

For SSI settlement, verify that
`developer-dashboard.ssi.txn-results` has a consumer.

- `messages_ready > 0` with no consumer means the dashboard listener is down or
  connected to another vhost/queue.
- A growing `messages_unacknowledged` count points to a blocked or failing
  consumer.
- Zero ready/unacknowledged messages does not prove delivery. Correlate the
  transaction processor publish log with the dashboard receive log.

Do not fetch messages from the production queue merely to view their payload.

## 8. Inspect dashboard MongoDB safely

MongoDB collection names are case-sensitive. The time-series ledger collection
is `creditLedger`, not `creditledgers`.

List relevant collections:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" -- node -e '
const m = require("mongoose");
(async () => {
  await m.connect(process.env.DATABASE_CONNECTION_PATH);
  const names = (await m.connection.db.listCollections({}, { nameOnly: true }).toArray())
    .map((item) => item.name)
    .filter((name) => /credit|authz/i.test(name));
  console.log(JSON.stringify(names, null, 2));
  await m.disconnect();
})().catch((error) => { console.error(error.message); process.exit(1); });
'
```

Read all plans for one service ID:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" -- \
  env DBG_APP_ID="$DBG_APP_ID" node -e '
const m = require("mongoose");
(async () => {
  await m.connect(process.env.DATABASE_CONNECTION_PATH);
  const plans = await m.connection.db.collection("creditplans")
    .find({ serviceId: process.env.DBG_APP_ID })
    .project({
      serviceId: 1, referenceId: 1, serviceType: 1, status: 1, source: 1,
      apiCredit: 1, onChainAllowance: 1, onChainAllowanceScopes: 1,
      expiresAt: 1, criticalBalance: 1, createdAt: 1, updatedAt: 1
    })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(JSON.stringify(plans, null, 2));
  await m.disconnect();
})().catch((error) => { console.error(error.message); process.exit(1); });
'
```

Read the latest ledger events:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" -- \
  env DBG_APP_ID="$DBG_APP_ID" node -e '
const m = require("mongoose");
(async () => {
  await m.connect(process.env.DATABASE_CONNECTION_PATH);
  const events = await m.connection.db.collection("creditLedger")
    .find({ "metadata.serviceId": process.env.DBG_APP_ID })
    .project({
      _id: 0, timestamp: 1, eventId: 1, eventType: 1, planId: 1,
      amount: 1, balanceAfter: 1, planBalanceAfter: 1,
      restoredAmount: 1, expiredAmount: 1, metadata: 1
    })
    .sort({ timestamp: -1 })
    .limit(100)
    .toArray();
  console.log(JSON.stringify(events, null, 2));
  await m.disconnect();
})().catch((error) => { console.error(error.message); process.exit(1); });
'
```

Read one plan's ledger history. Ledger plan IDs use the base dashboard plan ID,
without `.API_CREDIT` or `.BLOCKCHAIN_TXN_CREDIT`:

```sh
kubectl exec -n "$DBG_NAMESPACE" "$DBG_DASHBOARD_POD" -- \
  env DBG_APP_ID="$DBG_APP_ID" DBG_PLAN_ID="$DBG_PLAN_ID" node -e '
const m = require("mongoose");
(async () => {
  await m.connect(process.env.DATABASE_CONNECTION_PATH);
  const events = await m.connection.db.collection("creditLedger")
    .find({
      "metadata.serviceId": process.env.DBG_APP_ID,
      planId: process.env.DBG_PLAN_ID
    })
    .sort({ timestamp: 1 })
    .toArray();
  console.log(JSON.stringify(events, null, 2));
  await m.disconnect();
})().catch((error) => { console.error(error.message); process.exit(1); });
'
```

The queries call only `find`, `listCollections`, and projections. Do not paste
an `updateOne`, `findOneAndUpdate`, `deleteOne`, aggregation `$merge`, or
aggregation `$out` into a production diagnostic command.

## 9. Convert epoch milliseconds

Redis plan and event times are epoch milliseconds. On GNU/Linux:

```sh
export DBG_EPOCH_MS='1795005843919'
date -u -d "@${DBG_EPOCH_MS%???}"
TZ='Asia/Kolkata' date -d "@${DBG_EPOCH_MS%???}"
```

`${DBG_EPOCH_MS%???}` removes the final three millisecond digits. Keep the
original value when comparing Redis fields.

## 10. Consistency checks

For each credit type, compare these values:

| Check | Expected relationship |
| --- | --- |
| Redis aggregate | Sum of eligible `plans:remaining` values |
| Dashboard API available | `apiCredit.total - apiCredit.used` |
| Dashboard allowance available | `onChainAllowance.amount - onChainAllowance.usedAmount` |
| Active dashboard SSI plan | Corresponding Redis plan IDs for every granted credit type |
| Redis plan expiry | Same instant as dashboard `expiresAt` |
| Redis transition | Matching SDK Stream lifecycle event |
| Dashboard application | Matching `creditLedger.eventId`, applied once |
| Deferred reservation | Final commit/rollback after transaction result |

Allow for short transport lag while an event is actively moving through
BullMQ. Persistent disagreement after the queues are idle is an inconsistency,
not normal lag.

An important migration check is whether the grant used total or remaining
credit. For example:

```text
dashboard total = 4200
dashboard used = 75
dashboard available = 4125
Redis granted/remaining = 4200
```

This is a 75-credit overstatement in Redis. Either Redis must have been granted
the remaining amount, or the dashboard's used value must have been reset as
part of an explicitly defined migration. Do not choose one interpretation and
edit production manually; identify the grant command payload and migration
contract first.

## 11. Locate a stopped flow

Use this order for a missing grant:

1. Find the dashboard plan and activation time.
2. Find the grant job in `credit.commands.SSI_API`.
3. Find `CREDIT_GRANTED` in the SDK Stream.
4. Confirm the Redis plan and aggregate balance.
5. Find the deterministic lifecycle job in `credit.lifecycle`.
6. Find the same `eventId` in `creditLedger`.

Use this order for a stuck deferred transaction:

1. Read the reservation and its lease.
2. Confirm the SSI transaction job carried the same reservation ID.
3. Confirm the transaction processor logged success or failure.
4. Confirm it published a RabbitMQ result.
5. Confirm the dashboard received that result.
6. Find the commit or rollback job in `credit.commands.SSI_API`.
7. Find the terminal Redis reservation state and lifecycle event.
8. Confirm the dashboard ledger and plan counters applied the event.

Common conclusions:

| Last confirmed checkpoint | Likely area |
| --- | --- |
| Dashboard says queued; no BullMQ job | Dashboard producer/Redis connection or duplicate job ID |
| BullMQ command exists; no SDK Stream event | SDK command worker or rejected command |
| SDK Stream event exists; no lifecycle job | SDK Stream-to-BullMQ relay |
| Lifecycle job exists; no ledger event | Dashboard lifecycle worker or MongoDB transaction |
| Transaction completed; no RabbitMQ publish log | Transaction processor result publisher |
| RabbitMQ publish exists; no dashboard receive log | Binding, queue, vhost, or dashboard consumer |
| Dashboard queued commit; reservation stays `RESERVED` | SSI command queue/SDK command worker |
| Redis and ledger agree; dashboard counters do not | Dashboard event-application logic |
| App ID exists under another scope | Trusted request context mismatch |

## Evidence to save before any repair

Save the following in the incident ticket:

- Kubernetes context, namespace, pod names, and container restart counts;
- exact app, tenant, plan, reservation, request, event, job, and transaction IDs;
- Redis balance, plan order, remaining/status/expiry, and reservation output;
- relevant Stream entry and consumer-group pending summary;
- BullMQ state and attempts/failure metadata;
- transaction processor publish and dashboard receive log lines;
- dashboard plan projection and ledger events; and
- the observation time with timezone.

Only after this evidence is reviewed should an operator use an application
command such as retry, recovery, revoke, or reconciliation. Direct Redis or
MongoDB edits are not a supported repair path.
