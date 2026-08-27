import { CreditEventName } from './credit.enums';
import { CreditEnvironment, ResolvedCreditOptions } from './credit.types';
export {
  GET_BALANCE_SCRIPT,
  GET_RESERVATION_SCRIPT,
} from './credit.scripts';

export const DEFAULT_KEY_PREFIX = 'credit';
export const DEFAULT_REDIS_HASH_TAG = 'credit';

/** Compatibility alias; prefer the exported `CreditEventName` enum. */
export const CREDIT_EVENT_NAMES = CreditEventName;

export const DEFAULT_CREDIT_OPTIONS: ResolvedCreditOptions = {
  catalog: {
    serviceType: 'unconfigured',
    version: '0',
    routes: [],
  },
  leaseMs: 60_000,
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  recoveryBatchSize: 100,
  transport: {
    prefix: 'bull',
    lifecycleQueueNames: ['credit.lifecycle'],
    commandQueueName: 'credit.commands.unconfigured',
    consumerGroup: 'credit-bull-relay:unconfigured',
    batchSize: 100,
    blockMs: 5_000,
    pendingIdleMs: 30_000,
  },
  maxActivePlans: 1_000,
  maxPlanAllocationsPerReservation: 100,
  terminalPlanRetentionCount: 100,
  keyPrefix: DEFAULT_KEY_PREFIX,
  redisHashTag: DEFAULT_REDIS_HASH_TAG,
  eventStreamKey: `${DEFAULT_KEY_PREFIX}:v2:{${DEFAULT_REDIS_HASH_TAG}}:events`,
  eventStreamMaxLength: 100_000,
  requestContextResolver: (request: unknown) => {
    const req = request as {
      user?: { id?: string };
      service?: {
        businessId?: string;
        appId?: string;
        id?: string;
        tenantId?: string;
        environment?: CreditEnvironment;
      };
      requestId?: string;
    };
    return {
      subject: {
        appId:
          req.user?.id ??
          req.service?.businessId ??
          req.service?.appId ??
          req.service?.id ??
          '',
        tenantId: req.service?.tenantId,
      },
      requestId: req.requestId,
      environment: req.service?.environment as CreditEnvironment,
    };
  },
};
