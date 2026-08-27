/** Atomic Redis programs for FIFO recharge-plan credit lifecycle state. */

import {
  CreditBillingMode,
  CreditEventType,
  CreditPlanStatus,
  CreditReservationStatus,
} from './credit.enums';

export const OBSERVE_SCRIPT = `
local existingEventId = redis.call('HGET', KEYS[1], 'eventId')
if existingEventId then
  if redis.call('HGET', KEYS[1], 'amount') ~= ARGV[10]
    or redis.call('HGET', KEYS[1], 'operation') ~= ARGV[9]
    or redis.call('HGET', KEYS[1], 'environment') ~= ARGV[11] then
    return {-1}
  end
  return {existingEventId, 1}
end

local eventId = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[12], '*',
  'event', '${CreditEventType.CREDIT_OBSERVED}', 'timestamp', ARGV[1], 'serviceType', ARGV[2],
  'catalogVersion', ARGV[14],
  'scopeId', ARGV[3], 'appId', ARGV[4], 'tenantId', ARGV[5],
  'appType', ARGV[6], 'creditType', ARGV[7], 'requestId', ARGV[8],
  'operation', ARGV[9], 'requestedAmount', ARGV[10], 'deductedAmount', 0,
  'environment', ARGV[11], 'billingMode', '${CreditBillingMode.OBSERVE}')
redis.call('HSET', KEYS[1], 'eventId', eventId, 'amount', ARGV[10],
  'operation', ARGV[9], 'environment', ARGV[11])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[13]))
return {eventId, 0}
`;

export const RESERVE_SCRIPT = `
local existingId = redis.call('HGET', KEYS[9], 'reservationId')
if existingId then
  if redis.call('HGET', KEYS[9], 'amount') ~= ARGV[1]
    or redis.call('HGET', KEYS[9], 'settlementMode') ~= ARGV[13]
    or redis.call('HGET', KEYS[9], 'operation') ~= ARGV[14]
    or redis.call('HGET', KEYS[9], 'autoRecover') ~= ARGV[15]
    or redis.call('HGET', KEYS[9], 'environment') ~= ARGV[19] then
    return {-2}
  end
  return {existingId, redis.call('HGET', KEYS[9], 'remainingBalance'),
    redis.call('HGET', KEYS[9], 'expiresAt'), 1,
    redis.call('HGET', KEYS[9], 'leaseToken'),
    redis.call('HGET', KEYS[9], 'autoRecover'),
    redis.call('HGET', KEYS[9], 'allocations')}
end

local walletBalance = tonumber(redis.call('GET', KEYS[1]) or '0')
local planIds = redis.call('ZRANGE', KEYS[2], 0, -1)
local now = tonumber(ARGV[9])
for _, planId in ipairs(planIds) do
  local planExpiresAt = tonumber(redis.call('HGET', KEYS[4], planId) or '0')
  if planExpiresAt <= now then
    local unused = tonumber(redis.call('HGET', KEYS[3], planId) or '0')
    walletBalance = walletBalance - unused
    redis.call('HSET', KEYS[3], planId, 0)
    redis.call('HSET', KEYS[5], planId, '${CreditPlanStatus.EXPIRED}')
    redis.call('ZREM', KEYS[2], planId)
    if redis.call('HGET', KEYS[15], planId) == '1' then
      redis.call('ZADD', KEYS[13], now, planId)
    end
    local expirationMember = redis.call('HGET', KEYS[7], planId)
    if expirationMember then redis.call('ZREM', KEYS[11], expirationMember) end
    redis.call('XADD', KEYS[12], 'MAXLEN', '~', ARGV[16], '*',
      'event', '${CreditEventType.PLAN_EXPIRED}', 'timestamp', ARGV[9], 'serviceType', ARGV[18],
      'catalogVersion', ARGV[20],
      'scopeId', ARGV[3], 'appId', ARGV[4], 'tenantId', ARGV[5],
      'appType', ARGV[6], 'creditType', ARGV[7], 'planId', planId,
      'expiredAmount', unused, 'expiresAt', planExpiresAt,
      'planBalanceAfter', 0, 'balanceAfter', walletBalance)
  end
end
redis.call('SET', KEYS[1], walletBalance)

planIds = redis.call('ZRANGE', KEYS[2], 0, -1)
local needed = tonumber(ARGV[1])
local allocations = {}
for _, planId in ipairs(planIds) do
  if needed > 0 then
    local available = tonumber(redis.call('HGET', KEYS[3], planId) or '0')
    if available > 0 then
      if #allocations >= tonumber(ARGV[17]) then return {-4} end
      local take = math.min(available, needed)
      table.insert(allocations, {planId = planId, amount = take})
      needed = needed - take
    end
  end
end
if needed > 0 then return {-1} end

local finalBalance = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
for _, allocation in ipairs(allocations) do
  local after = redis.call('HINCRBY', KEYS[3], allocation.planId, -allocation.amount)
  allocation.planBalanceAfter = after
  if after == 0 then
    redis.call('HSET', KEYS[5], allocation.planId, '${CreditPlanStatus.DEPLETED}')
    redis.call('ZREM', KEYS[2], allocation.planId)
    if redis.call('HGET', KEYS[15], allocation.planId) == '1' then
      redis.call('ZADD', KEYS[13], now, allocation.planId)
    end
    local expirationMember = redis.call('HGET', KEYS[7], allocation.planId)
    if expirationMember then redis.call('ZREM', KEYS[11], expirationMember) end
  end
  if redis.call('HGET', KEYS[15], allocation.planId) == '1' then
    redis.call('HINCRBY', KEYS[14], allocation.planId, 1)
  end
end

local expiresAt = now + tonumber(ARGV[10])
local allocationsJson = cjson.encode(allocations)
redis.call('HSET', KEYS[8],
  'reservationId', ARGV[2], 'scopeId', ARGV[3], 'appId', ARGV[4],
  'tenantId', ARGV[5], 'appType', ARGV[6], 'creditType', ARGV[7],
  'requestId', ARGV[8], 'amount', ARGV[1], 'remainingBalance', finalBalance,
  'status', '${CreditReservationStatus.RESERVED}', 'leaseToken', ARGV[11], 'createdAt', ARGV[9],
  'expiresAt', expiresAt, 'version', 1, 'settlementMode', ARGV[13],
  'operation', ARGV[14], 'autoRecover', ARGV[15], 'environment', ARGV[19],
  'allocations', allocationsJson)
if ARGV[15] == '1' then redis.call('ZADD', KEYS[10], expiresAt, ARGV[2]) end
redis.call('HSET', KEYS[9], 'reservationId', ARGV[2],
  'remainingBalance', finalBalance, 'expiresAt', expiresAt, 'amount', ARGV[1],
  'settlementMode', ARGV[13], 'operation', ARGV[14], 'leaseToken', ARGV[11],
  'autoRecover', ARGV[15], 'environment', ARGV[19], 'allocations', allocationsJson)
for index, allocation in ipairs(allocations) do
  redis.call('XADD', KEYS[12], 'MAXLEN', '~', ARGV[16], '*',
    'event', '${CreditEventType.RESERVED}', 'timestamp', ARGV[9], 'serviceType', ARGV[18],
    'catalogVersion', ARGV[20],
    'scopeId', ARGV[3], 'appId', ARGV[4], 'tenantId', ARGV[5],
    'appType', ARGV[6], 'creditType', ARGV[7], 'requestId', ARGV[8],
    'operation', ARGV[14], 'amount', allocation.amount, 'totalAmount', ARGV[1],
    'planId', allocation.planId, 'planBalanceAfter', allocation.planBalanceAfter,
    'allocationIndex', index - 1, 'allocationCount', #allocations,
    'reservationId', ARGV[2], 'settlementMode', ARGV[13],
    'autoRecover', ARGV[15], 'expiresAt', expiresAt, 'balanceAfter', finalBalance,
    'environment', ARGV[19], 'billingMode', '${CreditBillingMode.ENFORCE}')
end
return {ARGV[2], finalBalance, expiresAt, 0, ARGV[11], ARGV[15], allocationsJson}
`;

export const COMMIT_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return {-2} end
if status == '${CreditReservationStatus.COMMITTED}' then return {0} end
if status ~= '${CreditReservationStatus.RESERVED}' then return {-1} end
local fields = redis.call('HMGET', KEYS[1], 'scopeId', 'appId', 'tenantId',
  'appType', 'creditType', 'amount', 'operation', 'remainingBalance',
  'allocations', 'environment')
local allocations = cjson.decode(fields[9])
local currentBalance = tonumber(redis.call('GET', KEYS[7]) or '0')
redis.call('HSET', KEYS[1], 'status', '${CreditReservationStatus.COMMITTED}', 'finalizedAt', ARGV[1],
  'finalizationReason', 'controller_succeeded')
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[3]))
for index, allocation in ipairs(allocations) do
  if redis.call('HGET', KEYS[10], allocation.planId) == '1' then
    local inflight = redis.call('HINCRBY', KEYS[9], allocation.planId, -1)
    if inflight < 0 then redis.call('HSET', KEYS[9], allocation.planId, 0) end
    if tonumber(redis.call('HGET', KEYS[5], allocation.planId) or '0') == 0 then
      redis.call('ZADD', KEYS[8], ARGV[1], allocation.planId)
    end
  end
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*',
    'event', '${CreditEventType.COMMITTED}', 'timestamp', ARGV[1], 'serviceType', ARGV[5],
    'catalogVersion', ARGV[6],
    'reservationId', ARGV[2], 'scopeId', fields[1], 'appId', fields[2],
    'tenantId', fields[3], 'appType', fields[4], 'creditType', fields[5],
    'planId', allocation.planId, 'amount', allocation.amount,
    'totalAmount', fields[6], 'allocationIndex', index - 1,
    'allocationCount', #allocations, 'operation', fields[7],
    'planBalanceAfter', allocation.planBalanceAfter, 'balanceAfter', fields[8],
    'environment', fields[10], 'billingMode', '${CreditBillingMode.ENFORCE}')
  local planBalanceAfter = tonumber(redis.call('HGET', KEYS[5], allocation.planId) or '0')
  local threshold = tonumber(redis.call('HGET', KEYS[6], allocation.planId) or '0')
  if planBalanceAfter <= threshold then
    redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[4], '*',
      'event', '${CreditEventType.CRITICAL_BALANCE}', 'timestamp', ARGV[1], 'serviceType', ARGV[5],
      'catalogVersion', ARGV[6],
      'scopeId', fields[1], 'appId', fields[2], 'tenantId', fields[3],
      'appType', fields[4], 'creditType', fields[5],
      'planId', allocation.planId, 'balanceAfter', currentBalance,
      'planBalanceAfter', planBalanceAfter,
      'threshold', threshold, 'environment', fields[10],
      'billingMode', '${CreditBillingMode.ENFORCE}')
  end
end
return {1}
`;

const REFUND_TRANSITION = `
local fields = redis.call('HMGET', KEYS[1], 'scopeId', 'appId', 'tenantId',
  'appType', 'creditType', 'amount', 'operation', 'allocations', 'environment')
local allocations = cjson.decode(fields[8])
local walletBalance = tonumber(redis.call('GET', KEYS[4]) or '0')
local resultingBalance = walletBalance
for _, allocation in ipairs(allocations) do
  local planId = allocation.planId
  local current = tonumber(redis.call('HGET', KEYS[5], planId) or '0')
  local planExpiresAt = tonumber(redis.call('HGET', KEYS[6], planId) or '0')
  local planStatus = redis.call('HGET', KEYS[7], planId) or '${CreditPlanStatus.EXPIRED}'
  if planExpiresAt > tonumber(ARGV[2]) and planStatus ~= '${CreditPlanStatus.EXPIRED}'
      and planStatus ~= '${CreditPlanStatus.REVOKED}' then
    resultingBalance = resultingBalance + tonumber(allocation.amount)
  else
    resultingBalance = resultingBalance - current
  end
end
if resultingBalance < 0 or resultingBalance > 9007199254740991 then return {-8} end
local outcomes = {}
local expiredPlans = {}
for _, allocation in ipairs(allocations) do
  local planId = allocation.planId
  if redis.call('HGET', KEYS[15], planId) == '1' then
    local inflight = redis.call('HINCRBY', KEYS[14], planId, -1)
    if inflight < 0 then redis.call('HSET', KEYS[14], planId, 0) end
  end
  local current = tonumber(redis.call('HGET', KEYS[5], planId) or '0')
  local planExpiresAt = tonumber(redis.call('HGET', KEYS[6], planId) or '0')
  local planStatus = redis.call('HGET', KEYS[7], planId) or '${CreditPlanStatus.EXPIRED}'
  if planExpiresAt > tonumber(ARGV[2]) and planStatus ~= '${CreditPlanStatus.EXPIRED}'
      and planStatus ~= '${CreditPlanStatus.REVOKED}' then
    local after = current + tonumber(allocation.amount)
    redis.call('HSET', KEYS[5], planId, after)
    redis.call('HSET', KEYS[7], planId, '${CreditPlanStatus.ACTIVE}')
    redis.call('ZADD', KEYS[8], tonumber(redis.call('HGET', KEYS[9], planId)), planId)
    local expirationMember = redis.call('HGET', KEYS[11], planId)
    if expirationMember then redis.call('ZADD', KEYS[10], planExpiresAt, expirationMember) end
    redis.call('ZREM', KEYS[13], planId)
    walletBalance = walletBalance + tonumber(allocation.amount)
    table.insert(outcomes, {planId = planId, amount = tonumber(allocation.amount),
      restoredAmount = tonumber(allocation.amount), expiredAmount = 0,
      planBalanceAfter = after})
  else
    if current > 0 then
      walletBalance = walletBalance - current
      redis.call('HSET', KEYS[5], planId, 0)
      table.insert(expiredPlans, {planId = planId, expiredAmount = current,
        expiresAt = planExpiresAt})
    end
    redis.call('HSET', KEYS[7], planId, '${CreditPlanStatus.EXPIRED}')
    redis.call('ZREM', KEYS[8], planId)
    local expirationMember = redis.call('HGET', KEYS[11], planId)
    if expirationMember then redis.call('ZREM', KEYS[10], expirationMember) end
    if redis.call('HGET', KEYS[15], planId) == '1' then
      redis.call('ZADD', KEYS[13], tonumber(ARGV[2]), planId)
    end
    table.insert(outcomes, {planId = planId, amount = tonumber(allocation.amount),
      restoredAmount = 0, expiredAmount = tonumber(allocation.amount),
      planBalanceAfter = 0})
  end
end
redis.call('SET', KEYS[4], walletBalance)
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'finalizedAt', ARGV[2],
  'finalizationReason', ARGV[3], 'remainingBalance', walletBalance)
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('PEXPIRE', KEYS[12], tonumber(ARGV[5]))
for _, expiredPlan in ipairs(expiredPlans) do
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[6], '*',
    'event', '${CreditEventType.PLAN_EXPIRED}', 'timestamp', ARGV[2], 'serviceType', ARGV[7],
    'catalogVersion', ARGV[8],
    'scopeId', fields[1], 'appId', fields[2], 'tenantId', fields[3],
    'appType', fields[4], 'creditType', fields[5], 'planId', expiredPlan.planId,
    'expiredAmount', expiredPlan.expiredAmount, 'expiresAt', expiredPlan.expiresAt,
    'planBalanceAfter', 0, 'balanceAfter', walletBalance)
end
for index, outcome in ipairs(outcomes) do
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[6], '*',
    'event', ARGV[1], 'timestamp', ARGV[2], 'serviceType', ARGV[7],
    'catalogVersion', ARGV[8],
    'reservationId', ARGV[4], 'scopeId', fields[1], 'appId', fields[2],
    'tenantId', fields[3], 'appType', fields[4], 'creditType', fields[5],
    'planId', outcome.planId, 'amount', outcome.amount, 'totalAmount', fields[6],
    'allocationIndex', index - 1, 'allocationCount', #outcomes,
    'restoredAmount', outcome.restoredAmount, 'expiredAmount', outcome.expiredAmount,
    'operation', fields[7], 'reason', ARGV[3],
    'planBalanceAfter', outcome.planBalanceAfter, 'balanceAfter', walletBalance,
    'environment', fields[9], 'billingMode', '${CreditBillingMode.ENFORCE}')
end
return {1, fields[1], fields[2], fields[3], fields[4], fields[5],
  fields[6], fields[7], walletBalance, cjson.encode(outcomes)}
`;

export const ROLLBACK_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status or status ~= '${CreditReservationStatus.RESERVED}' then return {0} end
${REFUND_TRANSITION}
`;

export const RENEW_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= '${CreditReservationStatus.RESERVED}' then return -1 end
if redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[1] then return -2 end
local expiresAt = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'expiresAt', expiresAt)
redis.call('HINCRBY', KEYS[1], 'version', 1)
if redis.call('HGET', KEYS[1], 'autoRecover') ~= '0' then
  redis.call('ZADD', KEYS[2], expiresAt, ARGV[4])
end
return expiresAt
`;

export const FIND_EXPIRED_SCRIPT = `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))`;
export const REMOVE_EXPIRATION_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

export const RECOVER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= '${CreditReservationStatus.RESERVED}' then
  redis.call('ZREM', KEYS[2], ARGV[4])
  return {0}
end
if redis.call('HGET', KEYS[1], 'autoRecover') == '0' then
  redis.call('ZREM', KEYS[2], ARGV[4])
  return {0}
end
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt > tonumber(ARGV[2]) then return {0} end
${REFUND_TRANSITION}
`;

export const GRANT_SCRIPT = `
local walletBalance = tonumber(redis.call('GET', KEYS[1]) or '0')
local activePlanIds = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, activePlanId in ipairs(activePlanIds) do
  local activeExpiresAt = tonumber(redis.call('HGET', KEYS[5], activePlanId) or '0')
  if activeExpiresAt <= tonumber(ARGV[5]) then
    local unused = tonumber(redis.call('HGET', KEYS[4], activePlanId) or '0')
    walletBalance = walletBalance - unused
    redis.call('HSET', KEYS[4], activePlanId, 0)
    redis.call('HSET', KEYS[8], activePlanId, '${CreditPlanStatus.EXPIRED}')
    redis.call('ZREM', KEYS[2], activePlanId)
    if redis.call('HGET', KEYS[16], activePlanId) == '1' then
      redis.call('ZADD', KEYS[15], tonumber(ARGV[5]), activePlanId)
    end
    local activeMember = redis.call('HGET', KEYS[9], activePlanId)
    if activeMember then redis.call('ZREM', KEYS[12], activeMember) end
    redis.call('XADD', KEYS[13], 'MAXLEN', '~', ARGV[14], '*',
      'event', '${CreditEventType.PLAN_EXPIRED}', 'timestamp', ARGV[5], 'serviceType', ARGV[16],
      'catalogVersion', ARGV[19],
      'scopeId', ARGV[6], 'appId', ARGV[7], 'tenantId', ARGV[8],
      'appType', ARGV[9], 'creditType', ARGV[10], 'planId', activePlanId,
      'expiredAmount', unused, 'expiresAt', activeExpiresAt,
      'planBalanceAfter', 0, 'balanceAfter', walletBalance)
  end
end
redis.call('SET', KEYS[1], walletBalance)
local existingAmount = redis.call('HGET', KEYS[3], ARGV[1])
if existingAmount then
  if existingAmount ~= ARGV[2]
    or redis.call('HGET', KEYS[5], ARGV[1]) ~= ARGV[4]
    or redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[3]
    or redis.call('HGET', KEYS[7], ARGV[1]) ~= ARGV[11]
    or redis.call('HGET', KEYS[14], ARGV[1]) ~= ARGV[18] then return {-1} end
  return {redis.call('GET', KEYS[1]) or 0,
    redis.call('HGET', KEYS[4], ARGV[1]) or 0, 1}
end
local ownerScope = redis.call('HGET', KEYS[10], 'scopeId')
if ownerScope and ownerScope ~= ARGV[6] then return {-6} end
local ownerReference = redis.call('HGET', KEYS[10], 'referenceId')
local referencePlan = redis.call('HGET', KEYS[11], 'planId')
local referenceScope = redis.call('HGET', KEYS[11], 'scopeId')
if referencePlan and (referencePlan ~= ARGV[1] or referenceScope ~= ARGV[6]) then return {-2} end
if ownerScope and not existingAmount and ownerReference ~= ARGV[11] then return {-1} end
if referencePlan and not existingAmount then
  if redis.call('HGET', KEYS[11], 'amount') ~= ARGV[2]
    or redis.call('HGET', KEYS[11], 'grantedAt') ~= ARGV[3]
    or redis.call('HGET', KEYS[11], 'expiresAt') ~= ARGV[4]
    or redis.call('HGET', KEYS[11], 'criticalBalance') ~= ARGV[18] then return {-1} end
  return {redis.call('GET', KEYS[1]) or 0, 0, 1}
end
if ownerScope and not existingAmount then return {-7} end
if tonumber(ARGV[4]) <= tonumber(ARGV[5]) then return {-5} end
if tonumber(redis.call('ZCARD', KEYS[2])) >= tonumber(ARGV[15]) then return {-3} end
local currentBalance = tonumber(redis.call('GET', KEYS[1]) or '0')
if currentBalance > 9007199254740991 - tonumber(ARGV[2]) then return {-4} end
local balance = redis.call('INCRBY', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[4])
redis.call('HSET', KEYS[6], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[7], ARGV[1], ARGV[11])
redis.call('HSET', KEYS[8], ARGV[1], '${CreditPlanStatus.ACTIVE}')
redis.call('HSET', KEYS[9], ARGV[1], ARGV[17])
redis.call('HSET', KEYS[14], ARGV[1], ARGV[18])
redis.call('HSET', KEYS[16], ARGV[1], 1)
redis.call('ZREM', KEYS[15], ARGV[1])
redis.call('HSET', KEYS[10], 'scopeId', ARGV[6], 'referenceId', ARGV[11])
redis.call('HSET', KEYS[11], 'planId', ARGV[1], 'scopeId', ARGV[6],
  'amount', ARGV[2], 'grantedAt', ARGV[3], 'expiresAt', ARGV[4],
  'criticalBalance', ARGV[18])
redis.call('ZADD', KEYS[12], ARGV[4], ARGV[17])
redis.call('XADD', KEYS[13], 'MAXLEN', '~', ARGV[14], '*',
  'event', '${CreditEventType.CREDIT_GRANTED}', 'timestamp', ARGV[5], 'serviceType', ARGV[16],
  'catalogVersion', ARGV[19],
  'scopeId', ARGV[6], 'appId', ARGV[7], 'tenantId', ARGV[8],
  'appType', ARGV[9], 'creditType', ARGV[10], 'planId', ARGV[1],
  'referenceId', ARGV[11], 'reason', ARGV[12], 'amount', ARGV[2],
  'grantedAt', ARGV[3], 'expiresAt', ARGV[4], 'criticalBalance', ARGV[18],
  'planBalanceAfter', ARGV[2], 'balanceAfter', balance)
return {balance, ARGV[2], 0}
`;

export const FIND_EXPIRED_PLANS_SCRIPT = `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))`;

export const EXPIRE_PLAN_SCRIPT = `
local planExpiresAt = tonumber(redis.call('HGET', KEYS[4], ARGV[2]) or '0')
if planExpiresAt == 0 then redis.call('ZREM', KEYS[6], ARGV[3]); return {0} end
if planExpiresAt > tonumber(ARGV[1]) then return {0} end
local status = redis.call('HGET', KEYS[5], ARGV[2])
if status == '${CreditPlanStatus.EXPIRED}' or status == '${CreditPlanStatus.REVOKED}' then
  redis.call('ZREM', KEYS[6], ARGV[3]); return {0}
end
local unused = tonumber(redis.call('HGET', KEYS[3], ARGV[2]) or '0')
local balance = tonumber(redis.call('GET', KEYS[1]) or '0') - unused
redis.call('SET', KEYS[1], balance)
redis.call('HSET', KEYS[3], ARGV[2], 0)
redis.call('HSET', KEYS[5], ARGV[2], '${CreditPlanStatus.EXPIRED}')
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[6], ARGV[3])
if redis.call('HGET', KEYS[10], ARGV[2]) == '1' then
  redis.call('ZADD', KEYS[9], tonumber(ARGV[1]), ARGV[2])
end
redis.call('XADD', KEYS[8], 'MAXLEN', '~', ARGV[10], '*',
  'event', '${CreditEventType.PLAN_EXPIRED}', 'timestamp', ARGV[1], 'serviceType', ARGV[4],
  'catalogVersion', ARGV[11],
  'scopeId', ARGV[5], 'appId', ARGV[6], 'tenantId', ARGV[7],
  'appType', ARGV[8], 'creditType', ARGV[9], 'planId', ARGV[2],
  'expiredAmount', unused, 'expiresAt', planExpiresAt,
  'planBalanceAfter', 0, 'balanceAfter', balance)
return {1, unused, balance}
`;

export const GET_RESERVATION_SCRIPT = `return redis.call('HGETALL', KEYS[1])`;

export const GET_BALANCE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local total = 0
local planIds = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, planId in ipairs(planIds) do
  if tonumber(redis.call('HGET', KEYS[4], planId) or '0') > tonumber(ARGV[1]) then
    total = total + tonumber(redis.call('HGET', KEYS[3], planId) or '0')
  end
end
return total
`;

export const CLEANUP_TERMINAL_PLANS_SCRIPT = `
local total = tonumber(redis.call('ZCARD', KEYS[1]))
local excess = total - tonumber(ARGV[1])
if excess <= 0 then return {0} end
local candidates = redis.call('ZRANGE', KEYS[1], 0, math.min(excess, tonumber(ARGV[2])) - 1)
local removed = 0
for _, planId in ipairs(candidates) do
  local tracked = redis.call('HGET', KEYS[3], planId)
  local inflight = tonumber(redis.call('HGET', KEYS[2], planId) or '0')
  local remaining = tonumber(redis.call('HGET', KEYS[5], planId) or '0')
  local status = redis.call('HGET', KEYS[9], planId)
  local terminal = status == '${CreditPlanStatus.DEPLETED}'
    or status == '${CreditPlanStatus.EXPIRED}'
    or status == '${CreditPlanStatus.REVOKED}'
  if tracked == '1' and inflight == 0 and remaining == 0 and terminal then
    local expirationMember = redis.call('HGET', KEYS[11], planId)
    if expirationMember then redis.call('ZREM', KEYS[13], expirationMember) end
    redis.call('ZREM', KEYS[12], planId)
    redis.call('ZREM', KEYS[1], planId)
    redis.call('HDEL', KEYS[4], planId)
    redis.call('HDEL', KEYS[5], planId)
    redis.call('HDEL', KEYS[6], planId)
    redis.call('HDEL', KEYS[7], planId)
    redis.call('HDEL', KEYS[8], planId)
    redis.call('HDEL', KEYS[9], planId)
    redis.call('HDEL', KEYS[10], planId)
    redis.call('HDEL', KEYS[11], planId)
    redis.call('HDEL', KEYS[2], planId)
    redis.call('HDEL', KEYS[3], planId)
    removed = removed + 1
  end
end
return {removed}
`;

export const GET_PLANS_SCRIPT = `
local plans = {}
local planIds = redis.call('HKEYS', KEYS[1])
if #planIds == 0 then return '[]' end
for _, planId in ipairs(planIds) do
  table.insert(plans, {planId = planId,
    grantedAmount = tonumber(redis.call('HGET', KEYS[1], planId)),
    availableAmount = tonumber(redis.call('HGET', KEYS[2], planId) or '0'),
    expiresAt = tonumber(redis.call('HGET', KEYS[3], planId) or '0'),
    grantedAt = tonumber(redis.call('HGET', KEYS[4], planId) or '0'),
    referenceId = redis.call('HGET', KEYS[5], planId) or '',
    status = redis.call('HGET', KEYS[6], planId) or '${CreditPlanStatus.EXPIRED}',
    criticalBalance = tonumber(redis.call('HGET', KEYS[7], planId) or '0')})
end
return cjson.encode(plans)
`;
