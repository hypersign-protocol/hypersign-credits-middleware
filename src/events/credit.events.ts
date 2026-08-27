import {
  CreditBillingMode,
  CreditEnvironment,
  CreditEventType,
} from '../credit.enums';
import { CreditSettlementMode, CreditSubject } from '../credit.types';

export { CreditEventType } from '../credit.enums';

/** Fields present on every credit event. */
export interface BaseCreditEvent {
  /** The specific event that occurred. */
  type: CreditEventType;
  /** Unix epoch milliseconds when the event was created. */
  timestamp: number;
  /** Complete wallet identity whose usage or balance is represented. */
  subject: CreditSubject;
  /** Convenience fields for logs and stream consumers. */
  appId: string;
  tenantId?: string;
  appType?: string;
  creditType?: string;
  scopeId: string;
  /** Present on every plan-affecting event. */
  planId?: string;
}

/** Emitted after a credit reservation is successfully created in Redis. */
export interface CreditReservedEvent extends BaseCreditEvent {
  type: CreditEventType.RESERVED;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  planId: string;
  reservationId: string;
  requestId?: string;
  /** Number reserved from this event's plan. */
  amount: number;
  totalAmount: number;
  allocationIndex: number;
  allocationCount: number;
  /** Scoped wallet balance after this reservation. */
  balanceAfter: number;
  planBalanceAfter: number;
  /** Unix epoch milliseconds when the lease expires if never settled. */
  expiresAt: number;
  /** Whether scheduled recovery may refund this reservation after expiry. */
  autoRecover: boolean;
  settlementMode: CreditSettlementMode;
  operation?: string;
}

/**
 * Emitted after a reservation is committed (the API call succeeded and the
 * credit deduction is permanent).
 */
export interface CreditCommittedEvent extends BaseCreditEvent {
  type: CreditEventType.COMMITTED;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  planId: string;
  reservationId: string;
  /** Number of credits that were permanently deducted. */
  amount: number;
  totalAmount: number;
  allocationIndex: number;
  allocationCount: number;
  /** Scoped wallet balance after the original reservation deduction. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/**
 * Emitted after a reservation is rolled back (the API call failed and credits
 * were refunded to the account).
 */
export interface CreditRolledBackEvent extends BaseCreditEvent {
  type: CreditEventType.ROLLED_BACK;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  planId: string;
  reservationId: string;
  /** Number of credits refunded. */
  amount: number;
  totalAmount: number;
  allocationIndex: number;
  allocationCount: number;
  restoredAmount: number;
  expiredAmount: number;
  /** Human-readable reason supplied by the caller or the interceptor. */
  reason: string;
  /** Scoped wallet balance after the refund. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/**
 * Emitted by CreditRecoveryService when it finds and refunds a reservation
 * whose lease expired without being settled (e.g. process crash).
 */
export interface CreditExpiredEvent extends BaseCreditEvent {
  type: CreditEventType.EXPIRED;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  planId: string;
  reservationId: string;
  /** Number of credits refunded by the recovery pass. */
  amount: number;
  totalAmount: number;
  allocationIndex: number;
  allocationCount: number;
  restoredAmount: number;
  expiredAmount: number;
  /** Scoped wallet balance after recovery refunded the reservation. */
  balanceAfter: number;
  planBalanceAfter: number;
  operation?: string;
}

/** Emitted after an idempotent credit top-up changes a scoped wallet. */
export interface CreditGrantedEvent extends BaseCreditEvent {
  type: CreditEventType.CREDIT_GRANTED;
  planId: string;
  referenceId: string;
  amount: number;
  balanceAfter: number;
  planBalanceAfter: number;
  criticalBalance: number;
  grantedAt: number;
  expiresAt: number;
  reason?: string;
}

export interface CreditPlanExpiredEvent extends BaseCreditEvent {
  type: CreditEventType.PLAN_EXPIRED;
  planId: string;
  expiredAmount: number;
  expiresAt: number;
  balanceAfter: number;
  planBalanceAfter: 0;
}

/**
 * Emitted after committed consumption leaves a plan at or below its immutable
 * `criticalBalance` threshold. Use this
 * to send low-balance alerts or trigger a top-up workflow.
 */
export interface CreditCriticalBalanceEvent extends BaseCreditEvent {
  type: CreditEventType.CRITICAL_BALANCE;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  planId: string;
  /** Current aggregate wallet balance. */
  balanceAfter: number;
  /** Current remaining balance of this event's plan. */
  planBalanceAfter: number;
  /** The configured threshold that was breached. */
  threshold: number;
}

/** Emitted for a dev request whose catalog usage was observed without billing. */
export interface CreditObservedEvent extends BaseCreditEvent {
  type: CreditEventType.CREDIT_OBSERVED;
  requestId: string;
  environment: CreditEnvironment.DEV;
  billingMode: CreditBillingMode.OBSERVE;
  requestedAmount: number;
  deductedAmount: 0;
  operation?: string;
}

/** Discriminated union of all events the SDK can emit. */
export type AnyCreditEvent =
  | CreditReservedEvent
  | CreditCommittedEvent
  | CreditRolledBackEvent
  | CreditExpiredEvent
  | CreditPlanExpiredEvent
  | CreditGrantedEvent
  | CreditObservedEvent
  | CreditCriticalBalanceEvent;
