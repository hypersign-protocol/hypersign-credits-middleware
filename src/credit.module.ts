import { DynamicModule, Module, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { DiscoveryModule } from "@nestjs/core";
import { CreditCatalogAuditor } from "./credit.catalog-auditor";
import { CreditCatalogService } from "./credit.catalog";
import { CreditPolicyExecutor } from "./credit-policy.executor";
import { CreditCommandWorker, CreditEventRelay } from "./credit.transport";
import { DEFAULT_CREDIT_OPTIONS } from "./credit.constants";
import { CreditRecoveryService } from "./credit-recovery.service";
import { CreditInterceptor } from "./credit.interceptor";
import { CreditService } from "./credit.service";
import { CreditBoundaryMiddleware } from "./credit-boundary.middleware";
import { CreditTransportInfrastructure } from "./credit-transport.infrastructure";
import {
  CREDIT_OPTIONS,
  CreditModuleAsyncOptions,
  CreditCatalog,
  CreditOptions,
  ResolvedCreditOptions,
} from "./credit.types";

const BUNDLED_CATALOG = loadBundledCatalog();
const runtimeProviders: Provider[] = [
  CreditCatalogService,
  CreditCatalogAuditor,
  CreditPolicyExecutor,
  CreditTransportInfrastructure,
  CreditEventRelay,
  CreditCommandWorker,
  CreditService,
  CreditBoundaryMiddleware,
  CreditRecoveryService,
  { provide: APP_INTERCEPTOR, useClass: CreditInterceptor },
];

export function resolveCreditOptions(
  options: CreditOptions,
): ResolvedCreditOptions {
  const serviceType = BUNDLED_CATALOG.serviceType?.trim();
  const catalogVersion = BUNDLED_CATALOG.version?.trim();
  if (!serviceType) throw new TypeError("catalog.serviceType is required");
  if (!catalogVersion) throw new TypeError("catalog.version is required");
  const catalog = {
    ...BUNDLED_CATALOG,
    serviceType,
    version: catalogVersion,
  };
  const keyPrefix =
    options.keyPrefix?.trim() || DEFAULT_CREDIT_OPTIONS.keyPrefix;
  const redisHashTag =
    options.redisHashTag?.trim() || DEFAULT_CREDIT_OPTIONS.redisHashTag;
  if (keyPrefix.includes("{") || keyPrefix.includes("}")) {
    throw new TypeError("keyPrefix cannot contain Redis hash-tag braces");
  }
  if (redisHashTag.includes("{") || redisHashTag.includes("}")) {
    throw new TypeError("redisHashTag cannot contain braces");
  }
  const resolved: ResolvedCreditOptions = {
    ...DEFAULT_CREDIT_OPTIONS,
    ...options,
    catalog,
    keyPrefix,
    redisHashTag,
    maxActivePlans:
      options.maxActivePlans ?? DEFAULT_CREDIT_OPTIONS.maxActivePlans,
    maxPlanAllocationsPerReservation:
      options.maxPlanAllocationsPerReservation ??
      DEFAULT_CREDIT_OPTIONS.maxPlanAllocationsPerReservation,
    terminalPlanRetentionCount:
      options.terminalPlanRetentionCount ??
      DEFAULT_CREDIT_OPTIONS.terminalPlanRetentionCount,
    eventStreamKey: `${keyPrefix}:v2:{${redisHashTag}}:events`,
    transport:
      options.transport === false
        ? false
        : {
            prefix: options.transport?.prefix?.trim() || "bull",
            lifecycleQueueNames:
              options.transport?.lifecycleQueueNames ?? ["credit.lifecycle"],
            commandQueueName:
              options.transport?.commandQueueName ?? `credit.commands.${serviceType}`,
            consumerGroup:
              options.transport?.consumerGroup ?? `credit-bull-relay:${serviceType}`,
            batchSize: options.transport?.batchSize ?? 100,
            blockMs: options.transport?.blockMs ?? 5_000,
            pendingIdleMs: options.transport?.pendingIdleMs ?? 30_000,
          },
  };
  for (const [name, value] of [
    ["leaseMs", resolved.leaseMs],
    ["retentionMs", resolved.retentionMs],
    ["recoveryBatchSize", resolved.recoveryBatchSize],
    ["maxActivePlans", resolved.maxActivePlans],
    [
      "maxPlanAllocationsPerReservation",
      resolved.maxPlanAllocationsPerReservation,
    ],
    ["terminalPlanRetentionCount", resolved.terminalPlanRetentionCount],
    ["eventStreamMaxLength", resolved.eventStreamMaxLength],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (resolved.transport) {
    for (const [name, value] of [
      ["transport.batchSize", resolved.transport.batchSize],
      ["transport.blockMs", resolved.transport.blockMs],
      ["transport.pendingIdleMs", resolved.transport.pendingIdleMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    if (
      resolved.transport.lifecycleQueueNames.length === 0 ||
      resolved.transport.lifecycleQueueNames.some((name) => !name.trim()) ||
      !resolved.transport.commandQueueName.trim() ||
      !resolved.transport.consumerGroup.trim() ||
      !resolved.transport.prefix.trim()
    ) {
      throw new TypeError(
        "transport queue and consumer-group names must be valid",
      );
    }
  }
  return resolved;
}

/**
 * Published profile builds contain exactly one `catalog.json`. The KYC source
 * catalog is used only while running the TypeScript source directly in tests.
 */
function loadBundledCatalog(): CreditCatalog {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./catalogs/catalog.json") as CreditCatalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("./catalogs/catalog.kyc.json") as CreditCatalog;
  }
}

@Module({})
export class CreditModule {
  static forRoot(options: CreditOptions): DynamicModule {
    return this.createDynamicModule({
      provide: CREDIT_OPTIONS,
      useValue: resolveCreditOptions(options),
    });
  }

  /** DI-friendly registration for configuration and host infrastructure providers. */
  static forRootAsync(options: CreditModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      {
        provide: CREDIT_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: any[]) => {
          const opts = await options.useFactory(...args);
          return resolveCreditOptions(opts);
        },
      },
      options.imports,
    );
  }

  private static createDynamicModule(
    optionsProvider: Provider,
    imports: CreditModuleAsyncOptions["imports"] = [],
  ): DynamicModule {
    return {
      module: CreditModule,
      global: true,
      imports: [DiscoveryModule, ...(imports ?? [])],
      providers: [optionsProvider, ...runtimeProviders],
      exports: [
        CREDIT_OPTIONS,
        CreditService,
        CreditRecoveryService,
        CreditBoundaryMiddleware,
        CreditCatalogService,
        CreditPolicyExecutor,
      ],
    };
  }
}
