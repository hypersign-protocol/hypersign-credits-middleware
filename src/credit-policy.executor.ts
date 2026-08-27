import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CreditCatalogService,
  ResolvedCreditCatalogCharge,
  ResolvedCreditCatalogRoute,
} from './credit.catalog';
import { CreditService } from './credit.service';
import {
  CreditBillingMode,
  CreditEnvironment,
  CreditReservationStatus,
} from './credit.enums';
import {
  CreditRequestContext,
  CreditSubject,
  ObserveCreditResult,
  ReserveCreditResult,
} from './credit.types';

export interface AppliedCreditReservation {
  billingMode: CreditBillingMode.ENFORCE;
  charge: ResolvedCreditCatalogCharge;
  reservation: ReserveCreditResult;
}

export interface AppliedCreditObservation {
  billingMode: CreditBillingMode.OBSERVE;
  charge: ResolvedCreditCatalogCharge;
  observation: ObserveCreditResult;
}

export type AppliedCreditAction =
  | AppliedCreditReservation
  | AppliedCreditObservation;

/** Shared catalog execution used by the HTTP interceptor and early boundary. */
@Injectable()
export class CreditPolicyExecutor {
  constructor(
    private readonly credits: CreditService,
    private readonly catalog: CreditCatalogService,
  ) {}

  async apply(
    route: ResolvedCreditCatalogRoute,
    context: CreditRequestContext,
  ): Promise<AppliedCreditAction[]> {
    if (!context.subject?.appId) {
      throw new UnauthorizedException('A billing subject is required');
    }
    const environment = this.environment(context.environment);
    const requestId = context.requestId?.trim() || randomUUID();
    return environment === CreditEnvironment.PROD
      ? this.reserve(route, context.subject, requestId)
      : this.observe(route, context.subject, requestId);
  }

  private async reserve(
    route: ResolvedCreditCatalogRoute,
    subject: CreditSubject,
    requestId: string,
  ): Promise<AppliedCreditReservation[]> {
    const applied: AppliedCreditReservation[] = [];
    try {
      for (const charge of route.charges) {
        const reservation = await this.credits.reserve({
          subject: this.subject(subject, charge.creditType),
          requestId: `${requestId}:${charge.id}`,
          amount: charge.amount,
          settlementMode: charge.settlementMode,
          operation: route.operation,
          autoRecover: charge.autoRecover,
          environment: CreditEnvironment.PROD,
        });
        applied.push({
          billingMode: CreditBillingMode.ENFORCE,
          charge,
          reservation,
        });
      }
      if (applied.some(({ reservation }) => reservation.existing)) {
        throw new ConflictException('This credit requestId already has a reservation');
      }
      return applied;
    } catch (error) {
      await this.rollbackNew(applied, 'catalog_reservation_failed');
      throw error;
    }
  }

  async claim(
    route: ResolvedCreditCatalogRoute,
    context: CreditRequestContext,
    applied: AppliedCreditAction[],
  ): Promise<AppliedCreditAction[]> {
    if (applied.length !== route.charges.length) {
      throw new BadRequestException('Early credit action count does not match catalog');
    }
    const environment = this.environment(context.environment);
    for (let index = 0; index < route.charges.length; index++) {
      const expected = route.charges[index];
      const value = applied[index];
      if (environment === CreditEnvironment.DEV) {
        if (value.billingMode !== CreditBillingMode.OBSERVE ||
            value.observation.environment !== CreditEnvironment.DEV ||
            value.observation.requestedAmount !== expected.amount ||
            value.observation.operation !== route.operation ||
            !sameSubject(
              value.observation.subject,
              this.subject(context.subject, expected.creditType),
            )) {
          throw new BadRequestException(
            `Early credit observation does not match catalog charge ${expected.id}`,
          );
        }
        continue;
      }
      if (value.billingMode !== CreditBillingMode.ENFORCE) {
        throw new BadRequestException(
          `Early credit reservation does not match catalog charge ${expected.id}`,
        );
      }
      const stored = await this.credits.getReservation(value.reservation.reservationId);
      const subject = this.subject(context.subject, expected.creditType);
      if (!stored || stored.status !== CreditReservationStatus.RESERVED ||
          stored.amount !== expected.amount ||
          stored.settlementMode !== expected.settlementMode ||
          stored.autoRecover !== expected.autoRecover ||
          stored.operation !== route.operation ||
          !sameSubject(stored.subject, subject)) {
        throw new BadRequestException(
          `Early credit reservation does not match catalog charge ${expected.id}`,
        );
      }
    }
    return applied;
  }

  async rollbackAll(applied: AppliedCreditAction[], reason: string): Promise<void> {
    await Promise.all(applied
      .filter((value): value is AppliedCreditReservation =>
        value.billingMode === CreditBillingMode.ENFORCE)
      .map(({ reservation }) =>
        this.credits.rollback(reservation.reservationId, reason),
      ));
  }

  private async observe(
    route: ResolvedCreditCatalogRoute,
    subject: CreditSubject,
    requestId: string,
  ): Promise<AppliedCreditObservation[]> {
    const applied: AppliedCreditObservation[] = [];
    for (const charge of route.charges) {
      const observation = await this.credits.observe({
        subject: this.subject(subject, charge.creditType),
        requestId: `${requestId}:${charge.id}`,
        amount: charge.amount,
        operation: route.operation,
        environment: CreditEnvironment.DEV,
      });
      applied.push({
        billingMode: CreditBillingMode.OBSERVE,
        charge,
        observation,
      });
    }
    if (applied.some(({ observation }) => observation.existing)) {
      throw new ConflictException('This credit requestId was already observed');
    }
    return applied;
  }

  private async rollbackNew(
    applied: AppliedCreditReservation[],
    reason: string,
  ): Promise<void> {
    await Promise.all(applied
      .filter(({ reservation }) => !reservation.existing)
      .map(({ reservation }) => this.credits.rollback(reservation.reservationId, reason)));
  }

  private subject(base: CreditSubject, creditType: string): CreditSubject {
    return { ...base, creditType };
  }

  private environment(value: unknown): CreditEnvironment {
    if (typeof value !== 'string') {
      throw new UnauthorizedException('A trusted billing environment is required');
    }
    const normalized = value.trim();
    if (
      normalized !== CreditEnvironment.PROD &&
      normalized !== CreditEnvironment.DEV
    ) {
      throw new UnauthorizedException('Billing environment must be prod or dev');
    }
    return normalized;
  }
}

function sameSubject(left: CreditSubject, right: CreditSubject): boolean {
  const value = (input?: string): string => input?.trim() ?? '';
  return value(left.appId) === value(right.appId) &&
    value(left.tenantId) === value(right.tenantId) &&
    value(left.appType) === value(right.appType) &&
    value(left.creditType) === value(right.creditType);
}
