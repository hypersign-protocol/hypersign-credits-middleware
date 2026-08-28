const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
const { DEFAULT_CREDIT_OPTIONS } = require('../dist/credit.constants');
const { CreditService } = require('../dist/credit.service');

async function removeVerificationKeys(redis, base) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${base}:*`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      if (!key.startsWith(`${base}:`)) {
        throw new Error(`Refusing to remove unexpected Redis key ${key}`);
      }
    }
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

async function main() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  const suffix = randomUUID();
  const keyPrefix = `credit-integration-${suffix}`;
  const redisHashTag = `credit-integration-${suffix}`;
  const base = `${keyPrefix}:v2:{${redisHashTag}}`;
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: { serviceType: 'integration', version: '1', routes: [] },
    keyPrefix,
    redisHashTag,
    eventStreamKey: `${base}:events`,
    leaseMs: 5_000,
  };
  const credits = new CreditService(redis, options);
  const subject = { appId: 'app-1', creditType: 'API_CREDIT' };
  const now = Date.now();

  try {
    await redis.connect();
    const devSubject = { appId: 'app-dev', creditType: 'API_CREDIT' };
    const observation = await credits.observe({
      subject: devSubject,
      requestId: 'request-dev',
      amount: 7,
      operation: 'integration-observation',
      environment: 'dev',
    });
    assert.equal(observation.deductedAmount, 0);
    assert.equal(observation.existing, false);
    assert.equal((await credits.observe({
      subject: devSubject,
      requestId: 'request-dev',
      amount: 7,
      operation: 'integration-observation',
      environment: 'dev',
    })).existing, true);
    assert.equal(await credits.getBalance(devSubject), null);

    assert.deepEqual(await credits.getPlans(subject), []);
    const oldGrant = {
      subject, planId: 'old-plan', amount: 10, grantedAt: now - 200,
      expiresAt: now + 60_000, referenceId: 'payment-old', criticalBalance: 0,
    };
    await credits.grant(oldGrant);
    assert.equal((await credits.grant(oldGrant)).existing, true);
    await credits.grant({
      subject, planId: 'new-plan', amount: 50, grantedAt: now - 100,
      expiresAt: now + 120_000, referenceId: 'payment-new', criticalBalance: 40,
    });
    const reservation = await credits.reserve({
      subject, amount: 25, requestId: 'request-1', operation: 'integration-test',
    });
    assert.deepEqual(reservation.allocations, [
      { planId: 'old-plan', amount: 10, planBalanceAfter: 0 },
      { planId: 'new-plan', amount: 15, planBalanceAfter: 35 },
    ]);
    assert.equal(await credits.commit(reservation.reservationId), true);
    assert.equal(await credits.getBalance(subject), 35);

    const rows = await redis.xrange(options.eventStreamKey, '-', '+');
    const committedPlans = rows
      .map(([, fields]) => Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) =>
          [fields[index * 2], fields[index * 2 + 1]]),
      ))
      .filter((event) => event.event === 'COMMITTED')
      .map((event) => event.planId);
    assert.deepEqual(committedPlans, ['old-plan', 'new-plan']);

    const rollbackSubject = { appId: 'app-rollback', creditType: 'API_CREDIT' };
    await credits.grant({
      subject: rollbackSubject, planId: 'rollback-old', amount: 5,
      grantedAt: now - 200, expiresAt: now + 120_000,
      referenceId: 'payment-rollback-old', criticalBalance: 0,
    });
    await credits.grant({
      subject: rollbackSubject, planId: 'rollback-new', amount: 10,
      grantedAt: now - 100, expiresAt: now + 120_000,
      referenceId: 'payment-rollback-new', criticalBalance: 0,
    });
    const rollbackReservation = await credits.reserve({
      subject: rollbackSubject, amount: 8, requestId: 'request-rollback',
    });
    assert.equal(await credits.rollback(rollbackReservation.reservationId), true);
    assert.equal(await credits.getBalance(rollbackSubject), 15);

    const recoveryReservation = await credits.reserve({
      subject: rollbackSubject, amount: 8, requestId: 'request-recovery',
    });
    assert.equal((await credits.recoverExpired(recoveryReservation.expiresAt + 1)).length, 1);
    assert.equal((await credits.recoverExpired(recoveryReservation.expiresAt + 1)).length, 0);
    assert.equal(await credits.getBalance(rollbackSubject), 15);

    const expirySubject = { appId: 'app-expiry', creditType: 'API_CREDIT' };
    await credits.grant({
      subject: expirySubject, planId: 'expiring-plan', amount: 20,
      grantedAt: now - 100, expiresAt: now + 1_000,
      referenceId: 'payment-expiring', criticalBalance: 0,
    });
    const expiryReservation = await credits.reserve({
      subject: expirySubject, amount: 10, requestId: 'request-expiry',
    });
    assert.equal((await credits.recoverExpiredPlans(now + 1_001)).length, 1);
    assert.equal(await credits.rollback(expiryReservation.reservationId), true);
    assert.equal(await credits.getBalance(expirySubject), 0);

    const revokeSubject = { appId: 'app-revoke', creditType: 'API_CREDIT' };
    await credits.grant({
      subject: revokeSubject, planId: 'revoked-plan', amount: 20,
      grantedAt: now - 100, expiresAt: now + 120_000,
      referenceId: 'payment-revoked', criticalBalance: 0,
    });
    const revokedReservation = await credits.reserve({
      subject: revokeSubject, amount: 5, requestId: 'request-revoked',
    });
    const revoked = await credits.revokePlan({
      subject: revokeSubject, planId: 'revoked-plan', reason: 'integration-test',
    });
    assert.equal(revoked.revokedAmount, 15);
    assert.equal(revoked.balance, 0);
    assert.equal(revoked.existing, false);
    assert.equal((await credits.revokePlan({
      subject: revokeSubject, planId: 'revoked-plan', reason: 'integration-test',
    })).existing, true);
    assert.equal(await credits.rollback(revokedReservation.reservationId), true);
    assert.equal(await credits.getBalance(revokeSubject), 0);
    assert.equal((await credits.getPlans(revokeSubject))[0].status, 'REVOKED');

    const cleanupCredits = new CreditService(redis, {
      ...options,
      terminalPlanRetentionCount: 2,
    });
    const cleanupSubject = { appId: 'app-cleanup', creditType: 'API_CREDIT' };
    const cleanupGrants = [];
    for (let index = 1; index <= 3; index += 1) {
      const input = {
        subject: cleanupSubject,
        planId: `cleanup-plan-${index}`,
        amount: 1,
        grantedAt: now - 1_000 + index,
        expiresAt: now + 120_000,
        referenceId: `payment-cleanup-${index}`,
        criticalBalance: 0,
      };
      cleanupGrants.push(input);
      await cleanupCredits.grant(input);
      const cleanupReservation = await cleanupCredits.reserve({
        subject: cleanupSubject,
        amount: 1,
        requestId: `request-cleanup-${index}`,
      });
      assert.equal(await cleanupCredits.commit(cleanupReservation.reservationId), true);
    }
    const cleanupPlans = (await cleanupCredits.getPlans(cleanupSubject))
      .map((plan) => plan.planId);
    assert.deepEqual(
      cleanupPlans,
      ['cleanup-plan-2', 'cleanup-plan-3'],
    );
    assert.equal(await cleanupCredits.getBalance(cleanupSubject), 0);
    const cleanupRetry = await cleanupCredits.grant(cleanupGrants[0]);
    assert.equal(cleanupRetry.planId, 'cleanup-plan-1');
    assert.equal(cleanupRetry.balance, 0);
    assert.equal(cleanupRetry.planBalance, 0);
    assert.equal(cleanupRetry.existing, true);
    process.stdout.write('Real Redis FIFO Lua verification passed\n');
  } finally {
    if (redis.status === 'ready') {
      await removeVerificationKeys(redis, base);
      await redis.quit();
    } else {
      redis.disconnect();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
