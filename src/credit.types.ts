import {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import {
  CreditBillingMode,
  CreditAccountType,
  CreditCatalogVersioning,
  CreditEnvironment,
  CreditPlanStatus,
  CreditReservationStatus,
  CreditSettlementMode,
} from './credit.enums';

export {
  CreditBillingMode,
  CreditAccountType,
  CreditCatalogVersioning,
  CreditEnvironment,
  CreditPlanStatus,
  CreditReservationStatus,
  CreditSettlementMode,
} from './credit.enums';

/** Injection token for the Redis client supplied by the host application. */
export const CREDIT_REDIS_CLIENT = 'REDIS_CLIENT';
export const CREDIT_OPTIONS = 'CREDIT_OPTIONS';

/** The subset of the ioredis/node-redis legacy eval API used by this SDK. */
export interface CreditRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  /** Creates an independent connection for SDK-owned blocking/BullMQ work. */
  duplicate?(override?: RedisOptions): Redis;
}

/** Dedicated Redis connection used only for blocking Stream consumption. */
export interface CreditEventStreamClient {
  xgroup(...args: any[]): Promise<unknown>;
  xreadgroup(...args: any[]): Promise<unknown>;
  xautoclaim(...args: any[]): Promise<unknown>;
  xack(...args: any[]): Promise<unknown>;
}

export interface CreditBullMqJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface CreditBullMqWorker {
  close(): Promise<void>;
}

/** Optional structural helper for external command producers/event consumers. */
export interface CreditBullMqProvider {
  add(
    queueName: string,
    jobName: string,
    data: unknown,
    options: { jobId: string },
  ): Promise<unknown>;
  createWorker(
    queueName: string,
    processor: (job: CreditBullMqJob) => Promise<unknown>,
  ): Promise<CreditBullMqWorker>;
}

export interface CreditCommandEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  commandId: string;
  schemaVersion: 3;
  serviceType: string;
  requestedAt?: string;
  source?: string;
  payload: TPayload;
}

export type GrantCreditCommandEnvelope = CreditCommandEnvelope<
  GrantCreditsInput & Record<string, unknown>
>;

export type RevokeCreditPlanCommandEnvelope = CreditCommandEnvelope<
  RevokeCreditPlanInput & Record<string, unknown>
>;

export interface CreditTransportOptions {
  /** BullMQ Redis key prefix. Default: "bull". */
  prefix?: string;
  lifecycleQueueNames?: string[];
  commandQueueName?: string;
  consumerGroup?: string;
  batchSize?: number;
  blockMs?: number;
  pendingIdleMs?: number;
}

export interface ResolvedCreditTransportOptions {
  prefix: string;
  lifecycleQueueNames: string[];
  commandQueueName: string;
  consumerGroup: string;
  batchSize: number;
  blockMs: number;
  pendingIdleMs: number;
}

/**
 * Uniquely identifies the wallet from which credits are deducted.
 * `appId` alone is sufficient for a global wallet. Add dimensions only
 * when balances are genuinely independent across those dimensions.
 */
export interface CreditSubject {
  appId: string;
  tenantId?: string;
  appType?: CreditAccountType | string;
  creditType?: string;
}

export interface CreditRequestContext {
  subject: CreditSubject;
  requestId?: string;
  /** Trusted per-request environment. prod enforces billing; dev observes only. */
  environment: CreditEnvironment;
}

export interface CreditCatalogCharge {
  /** Unique within one route; also scopes request idempotency. */
  id: string;
  creditType: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  autoRecover?: boolean;
}

export interface CreditCatalogRoute {
  method: string;
  path: string;
  /** Defaults to the canonical "METHOD /full/path". */
  operation?: string;
  /** Reserve before later application middleware; trusted identity must exist. */
  boundary?: boolean;
  /** An empty array explicitly declares a free endpoint. */
  charges: CreditCatalogCharge[];
}

export interface CreditCatalog {
  /** Installation/service identity used for transport routing, never wallet scoping. */
  serviceType: string;
  version: string;
  globalPrefix?: string;
  /** URI inserts v<version> into the route; NONE covers header/media/custom versioning. */
  versioning?: CreditCatalogVersioning;
  uriVersionPrefix?: string;
  /** Version applied by Nest when a controller or handler has no @Version metadata. */
  defaultVersion?: string;
  routes: CreditCatalogRoute[];
}

export interface ReserveCreditInput {
  subject: CreditSubject;
  requestId?: string;
  amount: number;
  settlementMode?: CreditSettlementMode;
  operation?: string;
  /** Enforced deductions are production-only. Defaults to prod. */
  environment?: CreditEnvironment.PROD;
  /**
   * When false, scheduled recovery never refunds this reservation merely
   * because its lease elapsed. It must be explicitly committed or rolled back.
   * Defaults to true.
   */
  autoRecover?: boolean;
}

export interface ReserveCreditResult {
  reservationId: string;
  /** Required to renew a long-running deferred reservation from any worker. */
  leaseToken: string;
  scopeId: string;
  remainingBalance: number;
  expiresAt: number;
  autoRecover: boolean;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  existing: boolean;
  settlementMode: CreditSettlementMode;
  subject: CreditSubject;
  allocations: CreditPlanAllocation[];
}

export interface ObserveCreditInput {
  subject: CreditSubject;
  requestId?: string;
  amount: number;
  operation?: string;
  environment: CreditEnvironment.DEV;
}

export interface ObserveCreditResult {
  eventId: string;
  requestId: string;
  scopeId: string;
  environment: CreditEnvironment.DEV;
  billingMode: CreditBillingMode.OBSERVE;
  requestedAmount: number;
  deductedAmount: 0;
  existing: boolean;
  operation?: string;
  subject: CreditSubject;
}

export interface GrantCreditsInput {
  subject: CreditSubject;
  /** Immutable identifier of this recharge lot. */
  planId: string;
  amount: number;
  /** Immutable low-balance threshold for this plan. */
  criticalBalance: number;
  /** Authoritative recharge creation time used for deterministic FIFO ordering. */
  grantedAt: number;
  /** Unix epoch milliseconds after which unused credits cannot be reserved. */
  expiresAt: number;
  /** Stable business transaction ID. A retry must reuse the same value. */
  referenceId: string;
  reason?: string;
}

export interface GrantCreditsResult {
  planId: string;
  planBalance: number;
  balance: number;
  expiresAt: number;
  criticalBalance: number;
  existing: boolean;
  subject: CreditSubject;
}

/** Trusted administrative request that permanently disables one plan. */
export interface RevokeCreditPlanInput {
  subject: CreditSubject;
  planId: string;
  reason?: string;
}

export interface RevokeCreditPlanResult {
  planId: string;
  revokedAmount: number;
  balance: number;
  existing: boolean;
  subject: CreditSubject;
}

export interface CreditPlanAllocation {
  planId: string;
  amount: number;
  /** Available amount in this plan immediately after reservation. */
  planBalanceAfter: number;
}

export interface CreditPlan {
  planId: string;
  subject: CreditSubject;
  scopeId: string;
  grantedAmount: number;
  availableAmount: number;
  criticalBalance: number;
  grantedAt: number;
  expiresAt: number;
  referenceId: string;
  status: CreditPlanStatus;
}

export interface CreditReservation extends CreditSubject {
  subject: CreditSubject;
  reservationId: string;
  scopeId: string;
  requestId?: string;
  amount: number;
  remainingBalance: number;
  status: CreditReservationStatus;
  createdAt: number;
  expiresAt: number;
  autoRecover: boolean;
  environment: CreditEnvironment.PROD;
  billingMode: CreditBillingMode.ENFORCE;
  finalizedAt?: number;
  finalizationReason?: string;
  settlementMode: CreditSettlementMode;
  operation?: string;
  /** Incremented by CreditService.renew(); starts at 1 on creation. */
  version: number;
  allocations: CreditPlanAllocation[];
}

export interface CreditOptions {
  /** SDK-owned BullMQ/Stream transport. Enabled with defaults unless false. */
  transport?: false | CreditTransportOptions;
  /** How long a request owns a reservation without renewal. Default: 60s. */
  leaseMs?: number;
  /** How long finalized audit records and request mappings remain. Default: 7d. */
  retentionMs?: number;
  /** Maximum expired reservations processed per recovery pass. Default: 100. */
  recoveryBatchSize?: number;
  /** Maximum number of active recharge plans one wallet may retain. */
  maxActivePlans?: number;
  /** Maximum number of plans one reservation may consume. */
  maxPlanAllocationsPerReservation?: number;
  /** Full terminal plans retained per wallet. Unfinished plans are never pruned. Default: 100. */
  terminalPlanRetentionCount?: number;
  /** Redis key prefix. Default: "credit". */
  keyPrefix?: string;
  /**
   * Redis Cluster hash tag. All Lua keys share this slot. Default: "credit".
   * A single tag favors correctness; shard separate SDK deployments when needed.
   */
  redisHashTag?: string;
  /** Approximate maximum entries kept in the audit stream. Default: 100000. */
  eventStreamMaxLength?: number;
  /** Resolves a trusted, authenticated billing subject for every request. */
  requestContextResolver?: (request: unknown) => CreditRequestContext;
}

export interface ResolvedCreditOptions {
  catalog: CreditCatalog;
  transport: false | ResolvedCreditTransportOptions;
  leaseMs: number;
  retentionMs: number;
  recoveryBatchSize: number;
  maxActivePlans: number;
  maxPlanAllocationsPerReservation: number;
  terminalPlanRetentionCount: number;
  keyPrefix: string;
  redisHashTag: string;
  eventStreamKey: string;
  eventStreamMaxLength: number;
  requestContextResolver: (request: unknown) => CreditRequestContext;
}

export interface CreditModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => CreditOptions | Promise<CreditOptions>;
}
