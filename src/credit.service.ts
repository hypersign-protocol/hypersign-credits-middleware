import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  COMMIT_SCRIPT,
  CLEANUP_TERMINAL_PLANS_SCRIPT,
  EXPIRE_PLAN_SCRIPT,
  FIND_EXPIRED_PLANS_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  GET_BALANCE_SCRIPT,
  GET_PLANS_SCRIPT,
  GET_RESERVATION_SCRIPT,
  GRANT_SCRIPT,
  OBSERVE_SCRIPT,
  RECOVER_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RENEW_SCRIPT,
  REVOKE_PLAN_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
} from './credit.scripts';
import { CreditKeyspace } from './credit-keyspace';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditPlanStatus,
  CreditReservationStatus,
  CreditSettlementMode,
} from './credit.enums';
import {
  CREDIT_OPTIONS,
  CREDIT_REDIS_CLIENT,
  CreditPlan,
  CreditPlanAllocation,
  CreditRedisClient,
  CreditReservation,
  CreditSubject,
  GrantCreditsInput,
  GrantCreditsResult,
  ObserveCreditInput,
  ObserveCreditResult,
  ReserveCreditInput,
  ReserveCreditResult,
  ResolvedCreditOptions,
  RevokeCreditPlanInput,
  RevokeCreditPlanResult,
} from './credit.types';

export class InsufficientCreditsException extends HttpException {
  constructor() { super('Insufficient credits', HttpStatus.PAYMENT_REQUIRED); }
}

export interface RecoveredReservation {
  subject: CreditSubject;
  scopeId: string;
  reservationId: string;
  amount: number;
  operation?: string;
  balanceAfter: number;
  allocations: CreditPlanAllocation[];
}

export interface ExpiredCreditPlan {
  subject: CreditSubject;
  scopeId: string;
  planId: string;
  expiredAmount: number;
  balanceAfter: number;
}

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);
  private readonly keys: CreditKeyspace;

  constructor(
    @Inject(CREDIT_REDIS_CLIENT) private readonly redis: CreditRedisClient,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {
    this.keys = new CreditKeyspace(options);
  }

  async reserve(input: ReserveCreditInput): Promise<ReserveCreditResult> {
    const subject = this.keys.subject(input.subject);
    positiveInteger(input.amount, 'amount');
    const settlementMode =
      input.settlementMode ?? CreditSettlementMode.IMMEDIATE;
    const environment = input.environment ?? CreditEnvironment.PROD;
    if (environment !== CreditEnvironment.PROD) {
      throw new TypeError('reserve() supports only the prod environment');
    }
    if (
      input.autoRecover === false &&
      settlementMode !== CreditSettlementMode.DEFERRED
    ) {
      throw new TypeError('autoRecover can be disabled only for DEFERRED reservations');
    }
    const reservationId = randomUUID();
    const leaseToken = randomUUID();
    const requestId = input.requestId?.trim() || randomUUID();
    const scopeId = this.keys.scopeId(subject);
    const now = Date.now();
    const operation = boundedText(input.operation ?? '', 'operation', 512);
    const autoRecover = input.autoRecover ?? true;
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      15,
      this.keys.balance(subject),
      this.keys.planOrder(subject),
      this.keys.planRemaining(subject),
      this.keys.planExpires(subject),
      this.keys.planStatuses(subject),
      this.keys.planGrantedAt(subject),
      this.keys.planExpirationMembers(subject),
      this.keys.reservation(reservationId),
      this.keys.request(subject, requestId),
      this.keys.expirations(),
      this.keys.planExpirations(),
      this.keys.eventStream(),
      this.keys.terminalPlans(subject),
      this.keys.planInflightReservations(subject),
      this.keys.trackedPlans(subject),
      input.amount,
      reservationId,
      scopeId,
      subject.appId,
      subject.tenantId ?? '',
      subject.appType ?? '',
      subject.creditType ?? '',
      requestId,
      now,
      this.options.leaseMs,
      leaseToken,
      this.options.retentionMs,
      settlementMode,
      operation,
      autoRecover ? '1' : '0',
      this.options.eventStreamMaxLength,
      this.options.maxPlanAllocationsPerReservation,
      this.options.catalog.serviceType,
      environment,
      this.options.catalog.version,
    ) as Array<string | number>;

    if (!Array.isArray(result)) throw new Error(`Unexpected Redis reserve result: ${String(result)}`);
    if (Number(result[0]) === -1) throw new InsufficientCreditsException();
    if (Number(result[0]) === -2) {
      throw new BadRequestException('requestId was reused with different credit semantics');
    }
    if (Number(result[0]) === -4) {
      throw new ServiceUnavailableException(
        'Credit cost spans more plans than maxPlanAllocationsPerReservation',
      );
    }
    if (result.length !== 7) throw new Error(`Unexpected Redis reserve result: ${String(result)}`);
    const allocations = parseAllocations(String(result[6]));
    const storedAutoRecover = String(result[5]) !== '0';
    await this.cleanupTerminalPlans(subject);
    return {
      reservationId: String(result[0]),
      leaseToken: String(result[4]),
      scopeId,
      remainingBalance: safeNonNegative(result[1], 'remainingBalance'),
      expiresAt: safePositive(result[2], 'expiresAt'),
      autoRecover: storedAutoRecover,
      environment: CreditEnvironment.PROD,
      billingMode: CreditBillingMode.ENFORCE,
      existing: Number(result[3]) === 1,
      settlementMode,
      subject,
      allocations,
    };
  }

  /** Records a dev usage event without reading or mutating wallet balances. */
  async observe(input: ObserveCreditInput): Promise<ObserveCreditResult> {
    const subject = this.keys.subject(input.subject);
    positiveInteger(input.amount, 'amount');
    if (input.environment !== CreditEnvironment.DEV) {
      throw new TypeError('observe() supports only the dev environment');
    }
    const requestId = identifier(input.requestId?.trim() || randomUUID(), 'requestId');
    const scopeId = this.keys.scopeId(subject);
    const operation = boundedText(input.operation?.trim() ?? '', 'operation', 512);
    const result = await this.redis.eval(
      OBSERVE_SCRIPT,
      2,
      this.keys.observation(subject, requestId),
      this.keys.eventStream(),
      Date.now(),
      this.options.catalog.serviceType,
      scopeId,
      subject.appId,
      subject.tenantId ?? '',
      subject.appType ?? '',
      subject.creditType ?? '',
      requestId,
      operation,
      input.amount,
      input.environment,
      this.options.eventStreamMaxLength,
      this.options.retentionMs,
      this.options.catalog.version,
    ) as Array<string | number>;
    if (!Array.isArray(result)) {
      throw new Error(`Unexpected Redis observe result: ${String(result)}`);
    }
    if (Number(result[0]) === -1) {
      throw new BadRequestException(
        'requestId was reused with different observation semantics',
      );
    }
    if (result.length !== 2) {
      throw new Error(`Unexpected Redis observe result: ${String(result)}`);
    }
    return {
      eventId: String(result[0]),
      requestId,
      scopeId,
      environment: CreditEnvironment.DEV,
      billingMode: CreditBillingMode.OBSERVE,
      requestedAmount: input.amount,
      deductedAmount: 0,
      existing: Number(result[1]) === 1,
      operation: operation || undefined,
      subject,
    };
  }

  /** Atomically creates one immutable recharge plan. */
  async grant(input: GrantCreditsInput): Promise<GrantCreditsResult> {
    const subject = this.keys.subject(input.subject);
    const planId = identifier(input.planId, 'planId');
    const referenceId = identifier(input.referenceId, 'referenceId');
    positiveInteger(input.amount, 'grant amount');
    nonNegativeInteger(input.criticalBalance, 'criticalBalance');
    positiveInteger(input.grantedAt, 'grantedAt');
    positiveInteger(input.expiresAt, 'expiresAt');
    const now = Date.now();
    if (input.grantedAt > now) throw new TypeError('grantedAt cannot be in the future');
    if (input.expiresAt <= input.grantedAt) {
      throw new TypeError('expiresAt must be later than grantedAt');
    }
    const scopeId = this.keys.scopeId(subject);
    const expirationMember = this.keys.planExpirationMember(subject, planId);
    const result = await this.redis.eval(
      GRANT_SCRIPT,
      16,
      this.keys.balance(subject),
      this.keys.planOrder(subject),
      this.keys.planAmounts(subject),
      this.keys.planRemaining(subject),
      this.keys.planExpires(subject),
      this.keys.planGrantedAt(subject),
      this.keys.planReferences(subject),
      this.keys.planStatuses(subject),
      this.keys.planExpirationMembers(subject),
      this.keys.planOwner(planId),
      this.keys.grant(referenceId),
      this.keys.planExpirations(),
      this.keys.eventStream(),
      this.keys.planCriticalBalances(subject),
      this.keys.terminalPlans(subject),
      this.keys.trackedPlans(subject),
      planId,
      input.amount,
      input.grantedAt,
      input.expiresAt,
      now,
      scopeId,
      subject.appId,
      subject.tenantId ?? '',
      subject.appType ?? '',
      subject.creditType ?? '',
      referenceId,
      boundedText(input.reason ?? '', 'reason', 2_048),
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
      this.options.maxActivePlans,
      this.options.catalog.serviceType,
      expirationMember,
      input.criticalBalance,
      this.options.catalog.version,
    ) as Array<string | number>;
    if (Number(result[0]) === -1) {
      throw new BadRequestException('planId was reused with different grant semantics');
    }
    if (Number(result[0]) === -2) {
      throw new BadRequestException('referenceId is already assigned to another plan');
    }
    if (Number(result[0]) === -3) {
      throw new ServiceUnavailableException('Wallet reached maxActivePlans');
    }
    if (Number(result[0]) === -4) {
      throw new BadRequestException('Grant would exceed the safe integer balance limit');
    }
    if (Number(result[0]) === -5) {
      throw new BadRequestException('A new plan cannot already be expired');
    }
    if (Number(result[0]) === -6) {
      throw new BadRequestException('planId is already owned by another wallet');
    }
    if (Number(result[0]) === -7) {
      throw new Error('Grant reference exists but its plan state is missing');
    }
    await this.cleanupTerminalPlans(subject);
    return {
      planId,
      balance: safeNonNegative(result[0], 'balance'),
      planBalance: safeNonNegative(result[1], 'planBalance'),
      expiresAt: input.expiresAt,
      criticalBalance: input.criticalBalance,
      existing: Number(result[2]) === 1,
      subject,
    };
  }

  /** Atomically removes unused credit and permanently revokes one plan. */
  async revokePlan(input: RevokeCreditPlanInput): Promise<RevokeCreditPlanResult> {
    const subject = this.keys.subject(input.subject);
    const planId = identifier(input.planId, 'planId');
    const scopeId = this.keys.scopeId(subject);
    const result = await this.redis.eval(
      REVOKE_PLAN_SCRIPT,
      9,
      this.keys.balance(subject),
      this.keys.planOrder(subject),
      this.keys.planRemaining(subject),
      this.keys.planStatuses(subject),
      this.keys.planExpirations(),
      this.keys.planExpirationMembers(subject),
      this.keys.eventStream(),
      this.keys.terminalPlans(subject),
      this.keys.trackedPlans(subject),
      Date.now(),
      planId,
      this.options.catalog.serviceType,
      scopeId,
      subject.appId,
      subject.tenantId ?? '',
      subject.appType ?? '',
      subject.creditType ?? '',
      boundedText(input.reason ?? '', 'reason', 2_048),
      this.options.eventStreamMaxLength,
      this.options.catalog.version,
    ) as Array<string | number>;
    if (!Array.isArray(result) || result.length !== 3) {
      throw new Error(`Unexpected Redis revoke result: ${String(result)}`);
    }
    const outcome = Number(result[0]);
    if (outcome === -1) {
      throw new BadRequestException('Credit plan does not exist in this wallet');
    }
    if (outcome === -2) {
      throw new BadRequestException('Expired credit plan cannot be revoked');
    }
    if (outcome === -3) {
      throw new Error('Plan remaining credit exceeds the wallet balance');
    }
    if (outcome !== 0 && outcome !== 1) {
      throw new Error(`Unexpected Redis revoke outcome: ${String(result[0])}`);
    }
    if (outcome === 1) await this.cleanupTerminalPlans(subject);
    return {
      planId,
      revokedAmount: safeNonNegative(result[1], 'revokedAmount'),
      balance: safeNonNegative(result[2], 'balance'),
      existing: outcome === 0,
      subject,
    };
  }

  async commit(reservationId: string): Promise<boolean> {
    const reservation = await this.getReservation(reservationId);
    if (!reservation) return false;
    const result = await this.redis.eval(
      COMMIT_SCRIPT,
      10,
      this.keys.reservation(reservationId),
      this.keys.expirations(),
      this.keys.eventStream(),
      this.keys.request(reservation.subject, reservation.requestId!),
      this.keys.planRemaining(reservation.subject),
      this.keys.planCriticalBalances(reservation.subject),
      this.keys.balance(reservation.subject),
      this.keys.terminalPlans(reservation.subject),
      this.keys.planInflightReservations(reservation.subject),
      this.keys.trackedPlans(reservation.subject),
      Date.now(),
      reservationId,
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
      this.options.catalog.serviceType,
      this.options.catalog.version,
    ) as Array<string | number>;
    const committed = Number(result[0]) === 1;
    if (committed) await this.cleanupTerminalPlans(reservation.subject);
    return committed;
  }

  async rollback(reservationId: string, reason = 'controller_failed'): Promise<boolean> {
    return this.refund(
      reservationId,
      CreditReservationStatus.ROLLED_BACK,
      boundedText(reason, 'reason', 2_048),
      Date.now(),
    );
  }

  async renew(reservationId: string, leaseToken: string): Promise<number> {
    if (!leaseToken) throw new TypeError('leaseToken is required');
    const result = Number(await this.redis.eval(
      RENEW_SCRIPT,
      2,
      this.keys.reservation(reservationId),
      this.keys.expirations(),
      leaseToken,
      Date.now(),
      this.options.leaseMs,
      reservationId,
    ));
    if (result < 0) throw new Error(`Reservation ${reservationId} cannot be renewed`);
    return result;
  }

  async recoverExpired(now = Date.now()): Promise<RecoveredReservation[]> {
    const ids = await this.redis.eval(
      FIND_EXPIRED_SCRIPT,
      1,
      this.keys.expirations(),
      now,
      this.options.recoveryBatchSize,
    ) as string[];
    const recovered: RecoveredReservation[] = [];
    for (const reservationId of ids) {
      const reservation = await this.getReservation(reservationId);
      if (!reservation) {
        await this.redis.eval(REMOVE_EXPIRATION_SCRIPT, 1, this.keys.expirations(), reservationId);
        continue;
      }
      const result = await this.refundResult(
        reservation,
        CreditReservationStatus.EXPIRED,
        'lease_expired',
        now,
        RECOVER_SCRIPT,
      );
      if (!result) continue;
      recovered.push({
        subject: reservation.subject,
        scopeId: reservation.scopeId,
        reservationId,
        amount: reservation.amount,
        operation: reservation.operation,
        balanceAfter: result.balanceAfter,
        allocations: result.allocations,
      });
    }
    return recovered;
  }

  async recoverExpiredPlans(now = Date.now()): Promise<ExpiredCreditPlan[]> {
    const members = await this.redis.eval(
      FIND_EXPIRED_PLANS_SCRIPT,
      1,
      this.keys.planExpirations(),
      now,
      this.options.recoveryBatchSize,
    ) as string[];
    const expired: ExpiredCreditPlan[] = [];
    for (const member of members) {
      const decoded = decodeExpirationMember(member);
      if (!decoded) {
        await this.redis.eval(REMOVE_EXPIRATION_SCRIPT, 1, this.keys.planExpirations(), member);
        continue;
      }
      const { subject, planId } = decoded;
      const scopeId = this.keys.scopeId(subject);
      const result = await this.redis.eval(
        EXPIRE_PLAN_SCRIPT,
        10,
        this.keys.balance(subject),
        this.keys.planOrder(subject),
        this.keys.planRemaining(subject),
        this.keys.planExpires(subject),
        this.keys.planStatuses(subject),
        this.keys.planExpirations(),
        this.keys.planExpirationMembers(subject),
        this.keys.eventStream(),
        this.keys.terminalPlans(subject),
        this.keys.trackedPlans(subject),
        now,
        planId,
        member,
        this.options.catalog.serviceType,
        scopeId,
        subject.appId,
        subject.tenantId ?? '',
        subject.appType ?? '',
        subject.creditType ?? '',
        this.options.eventStreamMaxLength,
        this.options.catalog.version,
      ) as Array<string | number>;
      if (Number(result[0]) !== 1) continue;
      await this.cleanupTerminalPlans(subject);
      expired.push({
        subject,
        scopeId,
        planId,
        expiredAmount: safeNonNegative(result[1], 'expiredAmount'),
        balanceAfter: safeNonNegative(result[2], 'balanceAfter'),
      });
    }
    return expired;
  }

  async getReservation(reservationId: string): Promise<CreditReservation | null> {
    const result = await this.redis.eval(
      GET_RESERVATION_SCRIPT,
      1,
      this.keys.reservation(reservationId),
    ) as string[];
    if (!result.length) return null;
    const data = pairs(result);
    const subject = this.keys.subject({
      appId: data.appId,
      tenantId: data.tenantId || undefined,
      appType: data.appType || undefined,
      creditType: data.creditType || undefined,
    });
    const expectedScopeId = this.keys.scopeId(subject);
    if (data.scopeId !== expectedScopeId) {
      throw new Error(`Redis reservation scope mismatch: expected ${expectedScopeId}, received ${data.scopeId}`);
    }
    return {
      ...subject,
      subject,
      reservationId: data.reservationId,
      scopeId: data.scopeId,
      requestId: data.requestId || undefined,
      amount: safePositive(data.amount, 'reservation amount'),
      remainingBalance: safeNonNegative(data.remainingBalance, 'remainingBalance'),
      status: reservationStatus(data.status),
      createdAt: safePositive(data.createdAt, 'createdAt'),
      expiresAt: safePositive(data.expiresAt, 'expiresAt'),
      autoRecover: data.autoRecover !== '0',
      environment: productionEnvironment(data.environment),
      billingMode: CreditBillingMode.ENFORCE,
      finalizedAt: data.finalizedAt ? safePositive(data.finalizedAt, 'finalizedAt') : undefined,
      finalizationReason: data.finalizationReason,
      settlementMode: settlementMode(data.settlementMode),
      operation: data.operation || undefined,
      version: safePositive(data.version, 'version'),
      allocations: parseAllocations(data.allocations),
    };
  }

  /** Returns null when no plan has ever been granted to this wallet. */
  async getBalance(subjectInput: CreditSubject): Promise<number | null> {
    const subject = this.keys.subject(subjectInput);
    const raw = await this.redis.eval(
      GET_BALANCE_SCRIPT,
      4,
      this.keys.balance(subject),
      this.keys.planOrder(subject),
      this.keys.planRemaining(subject),
      this.keys.planExpires(subject),
      Date.now(),
    );
    return raw === null || raw === false ? null : safeNonNegative(raw, 'balance');
  }

  async getPlans(subjectInput: CreditSubject): Promise<CreditPlan[]> {
    const subject = this.keys.subject(subjectInput);
    const raw = await this.redis.eval(
      GET_PLANS_SCRIPT,
      7,
      this.keys.planAmounts(subject),
      this.keys.planRemaining(subject),
      this.keys.planExpires(subject),
      this.keys.planGrantedAt(subject),
      this.keys.planReferences(subject),
      this.keys.planStatuses(subject),
      this.keys.planCriticalBalances(subject),
    );
    const parsed = JSON.parse(String(raw)) as Array<Record<string, unknown>>;
    const now = Date.now();
    return parsed.map((plan) => {
      const expiresAt = safePositive(plan.expiresAt, 'plan.expiresAt');
      const storedStatus = planStatus(plan.status);
      const status = expiresAt <= now && storedStatus !== CreditPlanStatus.REVOKED
        ? CreditPlanStatus.EXPIRED
        : storedStatus;
      return {
        planId: identifier(plan.planId, 'plan.planId'),
        subject,
        scopeId: this.keys.scopeId(subject),
        grantedAmount: safePositive(plan.grantedAmount, 'plan.grantedAmount'),
        availableAmount: status === CreditPlanStatus.EXPIRED
          ? 0
          : safeNonNegative(plan.availableAmount, 'plan.availableAmount'),
        criticalBalance: safeNonNegative(
          plan.criticalBalance,
          'plan.criticalBalance',
        ),
        grantedAt: safePositive(plan.grantedAt, 'plan.grantedAt'),
        expiresAt,
        referenceId: identifier(plan.referenceId, 'plan.referenceId'),
        status,
      };
    }).sort((left, right) =>
      left.grantedAt - right.grantedAt || left.planId.localeCompare(right.planId));
  }

  private async refund(
    reservationId: string,
    status:
      | CreditReservationStatus.ROLLED_BACK
      | CreditReservationStatus.EXPIRED,
    reason: string,
    now: number,
  ): Promise<boolean> {
    const reservation = await this.getReservation(reservationId);
    if (!reservation) return false;
    return Boolean(await this.refundResult(reservation, status, reason, now, ROLLBACK_SCRIPT));
  }

  private async refundResult(
    reservation: CreditReservation,
    status:
      | CreditReservationStatus.ROLLED_BACK
      | CreditReservationStatus.EXPIRED,
    reason: string,
    now: number,
    script: string,
  ): Promise<{ balanceAfter: number; allocations: CreditPlanAllocation[] } | null> {
    const subject = reservation.subject;
    const result = await this.redis.eval(
      script,
      15,
      this.keys.reservation(reservation.reservationId),
      this.keys.expirations(),
      this.keys.eventStream(),
      this.keys.balance(subject),
      this.keys.planRemaining(subject),
      this.keys.planExpires(subject),
      this.keys.planStatuses(subject),
      this.keys.planOrder(subject),
      this.keys.planGrantedAt(subject),
      this.keys.planExpirations(),
      this.keys.planExpirationMembers(subject),
      this.keys.request(subject, reservation.requestId!),
      this.keys.terminalPlans(subject),
      this.keys.planInflightReservations(subject),
      this.keys.trackedPlans(subject),
      status,
      now,
      reason,
      reservation.reservationId,
      this.options.retentionMs,
      this.options.eventStreamMaxLength,
      this.options.catalog.serviceType,
      this.options.catalog.version,
    ) as Array<string | number>;
    if (Number(result[0]) === -8) {
      throw new Error('Refund would exceed the safe integer balance limit');
    }
    if (Number(result[0]) !== 1) return null;
    const outcomes = JSON.parse(String(result[9])) as Array<Record<string, unknown>>;
    await this.cleanupTerminalPlans(subject);
    return {
      balanceAfter: safeNonNegative(result[8], 'balanceAfter'),
      allocations: outcomes.map((value) => ({
        planId: identifier(value.planId, 'allocation.planId'),
        amount: safePositive(value.amount, 'allocation.amount'),
        planBalanceAfter: safeNonNegative(value.planBalanceAfter, 'allocation.planBalanceAfter'),
      })),
    };
  }

  private async cleanupTerminalPlans(subject: CreditSubject): Promise<void> {
    try {
      await this.redis.eval(
        CLEANUP_TERMINAL_PLANS_SCRIPT,
        13,
        this.keys.terminalPlans(subject),
        this.keys.planInflightReservations(subject),
        this.keys.trackedPlans(subject),
        this.keys.planAmounts(subject),
        this.keys.planRemaining(subject),
        this.keys.planExpires(subject),
        this.keys.planGrantedAt(subject),
        this.keys.planReferences(subject),
        this.keys.planStatuses(subject),
        this.keys.planCriticalBalances(subject),
        this.keys.planExpirationMembers(subject),
        this.keys.planOrder(subject),
        this.keys.planExpirations(),
        this.options.terminalPlanRetentionCount,
        this.options.recoveryBatchSize,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Terminal plan cleanup failed and will retry later: ${message}`);
    }
  }

}

function parseAllocations(raw: string): CreditPlanAllocation[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Redis returned invalid allocations JSON'); }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Redis reservation must contain at least one plan allocation');
  }
  return value.map((allocation) => {
    if (!allocation || typeof allocation !== 'object') throw new Error('Invalid plan allocation');
    const entry = allocation as Record<string, unknown>;
    return {
      planId: identifier(entry.planId, 'allocation.planId'),
      amount: safePositive(entry.amount, 'allocation.amount'),
      planBalanceAfter: safeNonNegative(entry.planBalanceAfter, 'allocation.planBalanceAfter'),
    };
  });
}

function decodeExpirationMember(value: string): { subject: CreditSubject; planId: string } | null {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 5) return null;
    const [appId, tenantId, appType, creditType, planId] = decoded;
    if (typeof appId !== 'string' || typeof planId !== 'string') return null;
    return {
      subject: {
        appId,
        tenantId: typeof tenantId === 'string' && tenantId ? tenantId : undefined,
        appType: typeof appType === 'string' && appType ? appType : undefined,
        creditType: typeof creditType === 'string' && creditType ? creditType : undefined,
      },
      planId: identifier(planId, 'planId'),
    };
  } catch { return null; }
}

function pairs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) result[values[index]] = values[index + 1];
  return result;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const result = value.trim();
  if (/\p{Cc}/u.test(result)) throw new TypeError(`${field} cannot contain control characters`);
  return result;
}

function boundedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 12)} [truncated]`;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function productionEnvironment(value: unknown): CreditEnvironment.PROD {
  if (value !== CreditEnvironment.PROD) {
    throw new Error('Redis reservation environment must be prod');
  }
  return CreditEnvironment.PROD;
}

function safePositive(value: unknown, field: string): number {
  return positiveInteger(Number(value), field);
}

function safeNonNegative(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return result;
}

function planStatus(value: unknown): CreditPlanStatus {
  if (Object.values(CreditPlanStatus).includes(value as CreditPlanStatus)) {
    return value as CreditPlanStatus;
  }
  throw new Error(`Redis returned invalid plan status: ${String(value)}`);
}

function reservationStatus(value: unknown): CreditReservationStatus {
  if (
    Object.values(CreditReservationStatus).includes(
      value as CreditReservationStatus,
    )
  ) return value as CreditReservationStatus;
  throw new Error(`Redis returned invalid reservation status: ${String(value)}`);
}

function settlementMode(value: unknown): CreditReservation['settlementMode'] {
  if (Object.values(CreditSettlementMode).includes(value as CreditSettlementMode)) {
    return value as CreditSettlementMode;
  }
  throw new Error(`Redis returned invalid settlement mode: ${String(value)}`);
}

export {
  COMMIT_SCRIPT,
  EXPIRE_PLAN_SCRIPT,
  FIND_EXPIRED_PLANS_SCRIPT,
  FIND_EXPIRED_SCRIPT,
  GET_BALANCE_SCRIPT,
  GET_PLANS_SCRIPT,
  GRANT_SCRIPT,
  OBSERVE_SCRIPT,
  RECOVER_SCRIPT,
  REMOVE_EXPIRATION_SCRIPT,
  RENEW_SCRIPT,
  REVOKE_PLAN_SCRIPT,
  RESERVE_SCRIPT,
  ROLLBACK_SCRIPT,
};
