import { CreditSubject, ResolvedCreditOptions } from './credit.types';

/** Deterministic, delimiter-safe Redis keys for a scoped credit wallet. */
export class CreditKeyspace {
  constructor(private readonly options: ResolvedCreditOptions) {}

  subject(input: CreditSubject): CreditSubject {
    const clean = (value?: string) => value?.trim() || undefined;
    const subject: CreditSubject = {
      appId: clean(input.appId) ?? '',
      tenantId: clean(input.tenantId),
      appType: clean(input.appType),
      creditType: clean(input.creditType),
    };
    if (!subject.appId) throw new TypeError('subject.appId is required');
    return subject;
  }

  scopeId(input: CreditSubject): string {
    const subject = this.subject(input);
    const dimension = (value?: string): string =>
      value === undefined ? '0' : `1:${encodeURIComponent(value)}`;
    return [
      ['tenant', subject.tenantId],
      ['appType', subject.appType],
      ['app', subject.appId],
      ['creditType', subject.creditType],
    ].map(([name, value]) => `${name}=${dimension(value)}`).join('|');
  }

  balance(subject: CreditSubject): string { return `${this.base()}:balance:${this.scopeId(subject)}`; }
  planOrder(subject: CreditSubject): string { return `${this.base()}:plans:order:${this.scopeId(subject)}`; }
  planAmounts(subject: CreditSubject): string { return `${this.base()}:plans:amount:${this.scopeId(subject)}`; }
  planRemaining(subject: CreditSubject): string { return `${this.base()}:plans:remaining:${this.scopeId(subject)}`; }
  planExpires(subject: CreditSubject): string { return `${this.base()}:plans:expires:${this.scopeId(subject)}`; }
  planGrantedAt(subject: CreditSubject): string { return `${this.base()}:plans:granted-at:${this.scopeId(subject)}`; }
  planReferences(subject: CreditSubject): string { return `${this.base()}:plans:reference:${this.scopeId(subject)}`; }
  planStatuses(subject: CreditSubject): string { return `${this.base()}:plans:status:${this.scopeId(subject)}`; }
  planCriticalBalances(subject: CreditSubject): string {
    return `${this.base()}:plans:critical-balance:${this.scopeId(subject)}`;
  }
  planExpirationMembers(subject: CreditSubject): string {
    return `${this.base()}:plans:expiration-member:${this.scopeId(subject)}`;
  }
  planInflightReservations(subject: CreditSubject): string {
    return `${this.base()}:plans:inflight:${this.scopeId(subject)}`;
  }
  trackedPlans(subject: CreditSubject): string {
    return `${this.base()}:plans:tracked:${this.scopeId(subject)}`;
  }
  terminalPlans(subject: CreditSubject): string {
    return `${this.base()}:plans:terminal:${this.scopeId(subject)}`;
  }
  request(subject: CreditSubject, requestId: string): string {
    return `${this.base()}:request:${this.scopeId(subject)}:${encodeURIComponent(requestId)}`;
  }
  observation(subject: CreditSubject, requestId: string): string {
    return `${this.base()}:observation:${this.scopeId(subject)}:${encodeURIComponent(requestId)}`;
  }
  reservation(id: string): string { return `${this.base()}:reservation:${encodeURIComponent(id)}`; }
  grant(referenceId: string): string {
    return `${this.base()}:grant:${encodeURIComponent(referenceId)}`;
  }
  planOwner(planId: string): string {
    return `${this.base()}:plan-owner:${encodeURIComponent(planId)}`;
  }
  expirations(): string { return `${this.base()}:reservation:expirations`; }
  planExpirations(): string { return `${this.base()}:plan:expirations`; }
  planExpirationMember(subject: CreditSubject, planId: string): string {
    const value = this.subject(subject);
    return JSON.stringify([
      value.appId,
      value.tenantId ?? '',
      value.appType ?? '',
      value.creditType ?? '',
      planId,
    ]);
  }
  eventStream(): string { return this.options.eventStreamKey; }

  private base(): string {
    return `${this.options.keyPrefix}:v2:{${this.options.redisHashTag}}`;
  }
}
