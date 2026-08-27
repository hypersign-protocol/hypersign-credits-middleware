# Lua state transitions

All state and outbox operations execute atomically in Redis.
The TypeScript service owns validation and key construction; scripts own race
safety and idempotency.

## OBSERVE_SCRIPT

Records one `dev` catalog charge without reading or changing any wallet, plan, or
reservation key. It atomically writes `CREDIT_OBSERVED` to the transactional
outbox and an idempotency hash retained for `retentionMs`.

- exact request retry returns the original Stream event ID;
- changed amount, operation, or environment returns a conflict; and
- the event reports `requestedAmount`, `deductedAmount=0`, `environment=dev`,
  and `billingMode=OBSERVE`.

## GRANT_SCRIPT

Creates one immutable recharge plan. Before adding it, the script expires stale
active plans so `CREDIT_GRANTED.balanceAfter` is accurate.

It validates both identifiers:

- exact `planId` retry returns the existing result;
- changed financial fields for one `planId` return `-1`;
- a reference already assigned to another plan returns `-2`;
- active-plan capacity returns `-3`;
- safe-integer overflow returns `-4`;
- a new already-expired plan returns `-5`.

On success it updates the FIFO order, plan attribute hashes (including the
immutable `criticalBalance`), aggregate balance, plan-expiration index,
idempotency hash, and `CREDIT_GRANTED` event.

## RESERVE_SCRIPT

The script first validates request idempotency and expires any stale active
plans. It then performs two phases:

1. Read plans in `(grantedAt, planId)` order and construct the complete
   allocation without deducting.
2. Only when the full amount is available, decrement every selected plan and
   persist the reservation/allocation records.

Return codes:

```text
-1 insufficient combined balance
-2 requestId reused with different semantics
-4 allocation would exceed maxPlanAllocationsPerReservation
```

Expired-plan cleanup may still occur when a reservation is insufficient; the
credit reservation itself never partially deducts. One `RESERVED` event is
appended per allocation. Reserve never emits a low-balance alert because the
deduction is not permanent until commit.

Success returns:

```text
[reservationId, walletBalanceAfter, leaseExpiresAt, existing,
 leaseToken, autoRecover, allocationsJson]
```

## COMMIT_SCRIPT

Changes `RESERVED` to `COMMITTED`, removes the lease index, applies retention,
and appends one `COMMITTED` event for every stored plan allocation. Credit is not
deducted again. After each allocation event, it reads that plan's current
remaining balance and immutable threshold. If the plan is at or below its
threshold, it appends one `CRITICAL_BALANCE` event containing the plan and
aggregate balances.

Commit is allowed after a funding plan expires because eligibility was checked
at reservation time.

## ROLLBACK_SCRIPT

Uses the immutable allocation array:

- active plan: restore the allocation and reactivate a depleted plan;
- expired/revoked plan: restore zero and report the allocation as expired;
- a plan that has just expired: remove all other unused availability and append
  `PLAN_EXPIRED` before the rollback event.

One `ROLLED_BACK` event is appended per plan with `restoredAmount` and
`expiredAmount`. Before changing state, the script verifies that the final
wallet balance remains a non-negative safe integer; `-8` means it cannot refund
without overflowing. The reservation transition is idempotent.

## RECOVER_SCRIPT

Performs the same allocation-aware refund as rollback only when:

```text
status == RESERVED
autoRecover == true
lease expiresAt <= recovery time
```

It writes one reservation `EXPIRED` event per plan. Competing recovery workers
are safe because only the first script changes `RESERVED`.

## RENEW_SCRIPT

Validates reservation status and lease token, advances the lease expiry,
increments reservation version, and updates the expiration index. It never
changes plan expiry.

## EXPIRE_PLAN_SCRIPT

Removes unused availability from one due plan, sets `EXPIRED`, removes it from
FIFO and expiry indexes, adjusts the cached aggregate, and appends
`PLAN_EXPIRED`. Reserved allocations are already absent from plan availability
and remain settleable.

## FIND/REMOVE expiration scripts

Bounded sorted-set reads select due reservation IDs or encoded plan members.
Removal clears dangling members left by manual Redis damage or already-finalized
state.

## CLEANUP_TERMINAL_PLANS_SCRIPT

Keeps the newest `terminalPlanRetentionCount` depleted, expired, or revoked
plans in full. An older plan is removed from the wallet's plan-attribute hashes
only when it was created with cleanup tracking and its in-flight reservation
count is zero. Active plans, plans with reserved allocations, and pre-upgrade
plans are never removed. Persistent plan-owner and grant-reference records keep
old grant retries idempotent after full plan metadata is compacted.

## GET_BALANCE_SCRIPT

Returns `null` when no plan was ever granted. Otherwise it sums only unexpired
plans still present in the active FIFO index. This avoids reporting a stale
cached aggregate before an external expiry pass runs.

## GET_PLANS_SCRIPT and GET_RESERVATION_SCRIPT

Read plan metadata and reservation audit state. `CreditService` validates every
numeric field and allocation before returning it to application code.

## Change checklist

When modifying a script:

1. Keep TypeScript key and argument order identical.
2. Keep every key under the same Redis Cluster hash tag.
3. Preserve all-or-nothing allocation and idempotent finalization.
4. Write the lifecycle event in the same script as its mutation.
5. Test duplicate, concurrent, expiry, split-allocation, and malformed-state
   paths.
