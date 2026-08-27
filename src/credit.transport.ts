import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditCatalogService } from './credit.catalog';
import {
  CreditEventName,
  CreditEventType,
  CreditSettlementAction,
  CreditSettlementMode,
  CreditSettlementOutcome,
} from './credit.enums';
import { CreditService } from './credit.service';
import { CreditTransportInfrastructure } from './credit-transport.infrastructure';
import {
  CREDIT_OPTIONS,
  CreditBullMqJob,
  CreditCommandEnvelope,
  CreditEventStreamClient,
  CreditSubject,
  ResolvedCreditTransportOptions,
  ResolvedCreditOptions,
} from './credit.types';

export interface CreditLifecycleEventEnvelope {
  eventId: string;
  schemaVersion: 3;
  catalogVersion: string;
  serviceType: string;
  event: Record<string, unknown>;
}

const JOB_NAMES: Record<CreditEventType, CreditEventName> = {
  [CreditEventType.RESERVED]: CreditEventName.RESERVED,
  [CreditEventType.COMMITTED]: CreditEventName.COMMITTED,
  [CreditEventType.ROLLED_BACK]: CreditEventName.ROLLED_BACK,
  [CreditEventType.EXPIRED]: CreditEventName.EXPIRED,
  [CreditEventType.PLAN_EXPIRED]: CreditEventName.PLAN_EXPIRED,
  [CreditEventType.CREDIT_GRANTED]: CreditEventName.CREDIT_GRANTED,
  [CreditEventType.CREDIT_OBSERVED]: CreditEventName.CREDIT_OBSERVED,
  [CreditEventType.CRITICAL_BALANCE]: CreditEventName.CRITICAL_BALANCE,
};

/** Relays the transactional Redis Stream outbox through SDK-owned BullMQ queues. */
@Injectable()
export class CreditEventRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditEventRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private readonly consumer = `${process.pid}-${randomUUID()}`;

  constructor(
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
    private readonly catalog: CreditCatalogService,
    private readonly infrastructure: CreditTransportInfrastructure,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.options.transport;
    if (!config) return;
    const streamClient = this.infrastructure.streamClient();
    await this.createGroup(streamClient, config.consumerGroup);
    const claimed = await streamClient.xautoclaim(
      this.options.eventStreamKey,
      config.consumerGroup,
      this.consumer,
      config.pendingIdleMs,
      '0-0',
      'COUNT',
      config.batchSize,
    );
    await this.publishEntries(this.claimedEntries(claimed));
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.infrastructure.stopStreamReads();
    await this.loop;
  }

  private async run(): Promise<void> {
    const config = this.config();
    const streamClient = this.infrastructure.streamClient();
    const stream = this.options.eventStreamKey;
    while (this.running) {
      try {
        const claimed = await streamClient.xautoclaim(
          stream,
          config.consumerGroup,
          this.consumer,
          config.pendingIdleMs,
          '0-0',
          'COUNT',
          config.batchSize,
        );
        await this.publishEntries(this.claimedEntries(claimed));
        if (!this.running) break;
        const response = await streamClient.xreadgroup(
          'GROUP',
          config.consumerGroup,
          this.consumer,
          'COUNT',
          config.batchSize,
          'BLOCK',
          config.blockMs,
          'STREAMS',
          stream,
          '>',
        );
        await this.publishEntries(this.readEntries(response));
      } catch (error) {
        if (!this.running) break;
        if (this.isMissingConsumerGroup(error)) {
          try {
            await this.createGroup(streamClient, config.consumerGroup);
            this.logger.warn(
              `Recreated missing Redis Stream consumer group ${config.consumerGroup}`,
            );
          } catch (recoveryError) {
            const recoveryMessage = recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
            this.logger.error(
              `Credit event relay consumer-group recovery failed: ${recoveryMessage}`,
            );
          }
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Credit event relay pass failed: ${message}`);
        this.logger.warn(
          `Credit event relay will retry in ${config.blockMs}ms`,
        );
        await wait(config.blockMs);
      }
    }
  }

  private async publishEntries(entries: StreamEntry[]): Promise<void> {
    const config = this.config();
    const streamClient = this.infrastructure.streamClient();
    for (const [eventId, values] of entries) {
      const fields = pairs(values);
      const streamServiceType = fields.serviceType;
      if (!streamServiceType) {
        this.logger.error(
          `Credit stream event ${eventId} has no serviceType; leaving it pending`,
        );
        continue;
      }
      if (streamServiceType !== this.catalog.serviceType) {
        await streamClient.xack(
          this.options.eventStreamKey,
          config.consumerGroup,
          eventId,
        );
        continue;
      }
      const jobName = JOB_NAMES[fields.event as CreditEventType];
      if (!jobName) {
        this.logger.error(`Unknown credit stream event ${fields.event}; leaving ${eventId} pending`);
        continue;
      }
      const envelope: CreditLifecycleEventEnvelope = {
        eventId,
        schemaVersion: 3,
        catalogVersion: fields.catalogVersion || this.catalog.version,
        serviceType: this.catalog.serviceType,
        event: normalizeEvent(fields),
      };
      for (const queueName of config.lifecycleQueueNames) {
        await this.infrastructure.add(queueName, jobName, envelope, {
          jobId: `${this.catalog.serviceType}-${eventId}`,
        });
      }
      await streamClient.xack(
        this.options.eventStreamKey,
        config.consumerGroup,
        eventId,
      );
    }
  }

  private async createGroup(client: CreditEventStreamClient, group: string): Promise<void> {
    try {
      await client.xgroup('CREATE', this.options.eventStreamKey, group, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  private isMissingConsumerGroup(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('NOGROUP');
  }

  private claimedEntries(value: unknown): StreamEntry[] {
    if (!Array.isArray(value) || !Array.isArray(value[1])) return [];
    return value[1] as StreamEntry[];
  }

  private readEntries(value: unknown): StreamEntry[] {
    if (!Array.isArray(value)) return [];
    const result: StreamEntry[] = [];
    for (const stream of value as Array<[string, StreamEntry[]]>) {
      if (Array.isArray(stream?.[1])) result.push(...stream[1]);
    }
    return result;
  }

  private config(): ResolvedCreditTransportOptions {
    if (!this.options.transport) throw new Error('Credit transport is disabled');
    return this.options.transport;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Consumes trusted service-specific credit commands through an SDK-owned worker. */
@Injectable()
export class CreditCommandWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditCommandWorker.name);
  private worker?: { close(): Promise<void> };

  constructor(
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
    private readonly catalog: CreditCatalogService,
    private readonly credits: CreditService,
    private readonly infrastructure: CreditTransportInfrastructure,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.options.transport;
    if (!config) return;
    this.worker = await this.infrastructure.createWorker(
      config.commandQueueName,
      (job) => this.process(job),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: CreditBullMqJob): Promise<unknown> {
    let command: CreditCommandEnvelope | undefined;
    try {
      command = this.command(job);
      switch (job.name) {
        case CreditEventName.GRANT_REQUESTED:
          return this.credits.grant({
            subject: this.subject(command.payload.subject),
            planId: requiredString(command.payload.planId, 'payload.planId'),
            amount: positiveInteger(command.payload.amount, 'payload.amount'),
            criticalBalance: nonNegativeInteger(
              command.payload.criticalBalance,
              'payload.criticalBalance',
            ),
            grantedAt: positiveInteger(command.payload.grantedAt, 'payload.grantedAt'),
            expiresAt: positiveInteger(command.payload.expiresAt, 'payload.expiresAt'),
            referenceId: requiredString(
              command.payload.referenceId ?? command.commandId,
              'payload.referenceId',
            ),
            reason: optionalString(command.payload.reason),
          });
        case CreditEventName.RESERVE_REQUESTED:
          return this.credits.reserve({
            subject: this.subject(command.payload.subject),
            requestId: optionalString(command.payload.requestId) ?? command.commandId,
            amount: positiveInteger(command.payload.amount, 'payload.amount'),
            operation: requiredString(command.payload.operation, 'payload.operation'),
            settlementMode: deferredSettlement(command.payload.settlementMode),
            autoRecover: command.payload.autoRecover !== false,
          });
        case CreditEventName.COMMIT_REQUESTED:
          return this.settle(
            requiredString(command.payload.reservationId, 'payload.reservationId'),
            CreditSettlementAction.COMMIT,
          );
        case CreditEventName.ROLLBACK_REQUESTED:
          return this.settle(
            requiredString(command.payload.reservationId, 'payload.reservationId'),
            CreditSettlementAction.ROLLBACK,
            optionalString(command.payload.reason) ?? 'external_command',
          );
        default:
          throw new TypeError(`Unsupported credit command ${job.name}`);
      }
    } catch (error) {
      await this.publishRejection(command ?? {
        commandId: typeof job.id === 'string' && job.id ? job.id : randomUUID(),
        schemaVersion: 3,
        serviceType: this.catalog.serviceType,
        payload: {},
      }, job.name, error);
      throw error;
    }
  }

  private command(job: CreditBullMqJob): CreditCommandEnvelope {
    const value = job.data as Partial<CreditCommandEnvelope> | undefined;
    if (!value || value.schemaVersion !== 3 || !value.payload) {
      throw new TypeError('Invalid credit command envelope');
    }
    const commandId = requiredString(value.commandId ?? job.id, 'commandId');
    if (value.serviceType !== this.catalog.serviceType) {
      throw new TypeError(
        `Command serviceType ${String(value.serviceType)} does not match ${this.catalog.serviceType}`,
      );
    }
    return { ...value, commandId } as CreditCommandEnvelope;
  }

  private subject(value: unknown): CreditSubject {
    if (!value || typeof value !== 'object') throw new TypeError('payload.subject is required');
    const subject = value as Partial<CreditSubject>;
    return {
      appId: requiredString(subject.appId, 'payload.subject.appId'),
      tenantId: optionalString(subject.tenantId),
      appType: optionalString(subject.appType),
      creditType: requiredString(subject.creditType, 'payload.subject.creditType'),
    };
  }

  private async settle(
    reservationId: string,
    action: CreditSettlementAction,
    reason?: string,
  ): Promise<{ reservationId: string; outcome: string }> {
    const before = await this.credits.getReservation(reservationId);
    if (!before) {
      return { reservationId, outcome: CreditSettlementOutcome.NOT_FOUND };
    }
    const applied = action === CreditSettlementAction.COMMIT
      ? await this.credits.commit(reservationId)
      : await this.credits.rollback(reservationId, reason);
    if (applied) {
      return { reservationId, outcome: CreditSettlementOutcome.APPLIED };
    }
    const after = await this.credits.getReservation(reservationId);
    return {
      reservationId,
      outcome: after?.status ?? CreditSettlementOutcome.NOT_FOUND,
    };
  }

  private async publishRejection(
    command: CreditCommandEnvelope,
    commandName: string,
    error: unknown,
  ): Promise<void> {
    const config = this.options.transport;
    if (!config) throw new Error('Credit transport is disabled');
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(`Rejected credit command ${command.commandId}: ${reason}`);
    for (const queueName of config.lifecycleQueueNames) {
      await this.infrastructure.add(queueName, CreditEventName.COMMAND_REJECTED, {
        schemaVersion: 3,
        serviceType: this.catalog.serviceType,
        planId: optionalString(command.payload.planId),
        commandId: command.commandId,
        commandName,
        reason,
        timestamp: Date.now(),
      }, { jobId: `${this.catalog.serviceType}-${command.commandId}-rejected` });
    }
  }
}

type StreamEntry = [string, string[]];

function pairs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    result[values[index]] = values[index + 1];
  }
  return result;
}

function normalizeEvent(fields: Record<string, string>): Record<string, unknown> {
  const numeric = new Set([
    'timestamp', 'amount', 'totalAmount', 'balanceAfter', 'planBalanceAfter',
    'threshold', 'expiresAt', 'grantedAt', 'expiredAmount',
    'restoredAmount', 'allocationIndex', 'allocationCount', 'criticalBalance',
    'requestedAmount', 'deductedAmount',
  ]);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (numeric.has(name)) result[name] = Number(value);
    else if (name === 'autoRecover') result[name] = value === '1';
    else if (value !== '') result[name] = value;
  }
  result.type = fields.event;
  delete result.event;
  delete result.catalogVersion;
  result.subject = {
    appId: fields.appId,
    ...(fields.tenantId ? { tenantId: fields.tenantId } : {}),
    ...(fields.appType ? { appType: fields.appType } : {}),
    ...(fields.creditType ? { creditType: fields.creditType } : {}),
  };
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function deferredSettlement(value: unknown): CreditSettlementMode.DEFERRED {
  if (value !== undefined && value !== CreditSettlementMode.DEFERRED) {
    throw new TypeError('Command reservations support only DEFERRED settlement');
  }
  return CreditSettlementMode.DEFERRED;
}
