/** Trusted billing environment attached to each API request. */
export enum CreditEnvironment {
  PROD = 'prod',
  DEV = 'dev',
}

/** Whether a catalog charge changes balance or is observation-only. */
export enum CreditBillingMode {
  ENFORCE = 'ENFORCE',
  OBSERVE = 'OBSERVE',
}

/** When an enforced reservation becomes a permanent deduction. */
export enum CreditSettlementMode {
  IMMEDIATE = 'IMMEDIATE',
  DEFERRED = 'DEFERRED',
}

/** Persisted lifecycle of one immutable credit plan. */
export enum CreditPlanStatus {
  ACTIVE = 'ACTIVE',
  DEPLETED = 'DEPLETED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

/** Persisted lifecycle of one credit reservation. */
export enum CreditReservationStatus {
  RESERVED = 'RESERVED',
  COMMITTED = 'COMMITTED',
  ROLLED_BACK = 'ROLLED_BACK',
  EXPIRED = 'EXPIRED',
}

/** Nest route-versioning modes supported by the bundled catalog. */
export enum CreditCatalogVersioning {
  URI = 'URI',
  NONE = 'NONE',
}

/** Common wallet account categories; custom app types remain supported. */
export enum CreditAccountType {
  USER = 'USER',
  BUSINESS = 'BUSINESS',
  SERVICE = 'SERVICE',
}

/**
 * Identifies the API service whose catalog and transport queues this SDK uses.
 *
 * This value belongs in `catalog.serviceType`, command envelopes, lifecycle
 * envelopes, and service-specific queue names. It is transport metadata and is
 * not one of the fields used to calculate a wallet's identity.
 */
export enum CreditServiceType {
  EXAMPLE_API = 'EXAMPLE_API',
  SSI_API = 'SSI_API',
  CAVACH_API = 'CAVACH_API',
}

/**
 * Identifies the application category inside a `CreditSubject` wallet key.
 *
 * This value belongs in `subject.appType`. Unlike `CreditServiceType`, it is a
 * wallet dimension, so a plan grant and an API request must use the same
 * `CreditAppType` to access the same balance. The current CAVACH integration
 * intentionally serializes both enums as `CAVACH_API`, but their roles are not
 * interchangeable.
 */
export enum CreditAppType {
  EXAMPLE_API = 'EXAMPLE_API',
  SSI_API = 'SSI_API',
  CAVACH_API = 'CAVACH_API',
}

/** Credit currencies bundled with this SDK release. */
export enum CreditType {
  API_CREDIT = 'API_CREDIT',
  BLOCKCHAIN_TXN_CREDIT = 'BLOCKCHAIN_TXN_CREDIT',
}

/** Event type identifiers stored in the Redis outbox. */
export enum CreditEventType {
  RESERVED = 'RESERVED',
  COMMITTED = 'COMMITTED',
  ROLLED_BACK = 'ROLLED_BACK',
  EXPIRED = 'EXPIRED',
  PLAN_EXPIRED = 'PLAN_EXPIRED',
  PLAN_REVOKED = 'PLAN_REVOKED',
  CREDIT_GRANTED = 'CREDIT_GRANTED',
  CREDIT_OBSERVED = 'CREDIT_OBSERVED',
  CRITICAL_BALANCE = 'CRITICAL_BALANCE',
}

/** BullMQ job names published or consumed by the SDK. */
export enum CreditEventName {
  RESERVED = 'credit.reserved',
  COMMITTED = 'credit.committed',
  ROLLED_BACK = 'credit.rolled-back',
  EXPIRED = 'credit.expired',
  PLAN_EXPIRED = 'credit.plan-expired',
  PLAN_REVOKED = 'credit.plan-revoked',
  CREDIT_GRANTED = 'credit.granted',
  CRITICAL_BALANCE = 'credit.critical-balance',
  CREDIT_OBSERVED = 'credit.observed',
  COMMAND_REJECTED = 'credit.command-rejected',
  GRANT_REQUESTED = 'credit.grant.requested',
  RESERVE_REQUESTED = 'credit.reserve.requested',
  COMMIT_REQUESTED = 'credit.commit.requested',
  ROLLBACK_REQUESTED = 'credit.rollback.requested',
  PLAN_REVOKE_REQUESTED = 'credit.plan-revoke.requested',
}

/** Settlement actions accepted by trusted command messages. */
export enum CreditSettlementAction {
  COMMIT = 'COMMIT',
  ROLLBACK = 'ROLLBACK',
}

/** Non-status outcomes returned after processing a settlement command. */
export enum CreditSettlementOutcome {
  APPLIED = 'APPLIED',
  NOT_FOUND = 'NOT_FOUND',
}
