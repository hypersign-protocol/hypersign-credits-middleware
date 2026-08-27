import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  CreditAppType,
  CreditEventName,
  CreditServiceType,
  CreditType,
} from '../../src';
import { ExampleBullMqProvider } from '../bullmq.module';
import { CreditEventStore } from './event-store.service';

interface GrantCreditRequest {
  tenantId?: unknown;
  appId?: unknown;
  amount?: unknown;
  planId?: unknown;
  grantedAt?: unknown;
  expiresAt?: unknown;
  reason?: unknown;
}

@Controller()
export class CreditEventsController {
  constructor(
    private readonly bullMq: ExampleBullMqProvider,
    private readonly store: CreditEventStore,
  ) {}

  @Get('credit-events')
  events(@Query('limit') rawLimit?: string) {
    const parsed = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
      throw new BadRequestException('limit must be an integer from 1 to 250');
    }
    return this.store.recent(parsed);
  }

  @Post('credit-commands/grant')
  async grant(@Body() body: GrantCreditRequest) {
    const appId = requiredString(body.appId, 'appId');
    const amount = positiveInteger(body.amount, 'amount');
    const criticalBalance = Math.floor(amount * 0.4);
    const planId = requiredString(body.planId, 'planId');
    if (planId.includes(':')) {
      throw new BadRequestException('planId cannot contain a colon');
    }
    const grantedAt = positiveInteger(body.grantedAt, 'grantedAt');
    const expiresAt = positiveInteger(body.expiresAt, 'expiresAt');
    if (grantedAt > Date.now()) {
      throw new BadRequestException('grantedAt cannot be in the future');
    }
    if (expiresAt <= grantedAt) {
      throw new BadRequestException('expiresAt must be later than grantedAt');
    }
    if (expiresAt <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    const tenantId = optionalString(body.tenantId);
    const commandId = `grant-${CreditServiceType.CAVACH_API}-${planId}`;
    const referenceId = `example-grant-${planId}`;
    const queue = `credit.commands.${CreditServiceType.CAVACH_API}`;
    await this.bullMq.add(queue, CreditEventName.GRANT_REQUESTED, {
      schemaVersion: 3,
      commandId,
      serviceType: CreditServiceType.CAVACH_API,
      source: 'example-credit-event-server',
      requestedAt: new Date().toISOString(),
      payload: {
        subject: {
          appId,
          appType: CreditAppType.CAVACH_API,
          creditType: CreditType.API_CREDIT,
          ...(tenantId ? { tenantId } : {}),
        },
        amount,
        criticalBalance,
        planId,
        grantedAt,
        expiresAt,
        referenceId,
        reason: optionalString(body.reason) ?? 'demo_credit_grant',
      },
    }, { jobId: commandId });

    return { queued: true, commandId, queue, planId, referenceId };
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BadRequestException(`${field} must be a positive safe integer`);
  }
  return Number(value);
}
