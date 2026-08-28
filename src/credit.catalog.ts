import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  CreditCatalog,
  CreditCatalogCharge,
  CreditCatalogChargeCondition,
  CreditCatalogRoute,
  CREDIT_OPTIONS,
  ResolvedCreditOptions,
} from './credit.types';
import {
  CreditCatalogVersioning,
  CreditSettlementMode,
} from './credit.enums';

export interface ResolvedCreditCatalogCharge extends CreditCatalogCharge {
  settlementMode: CreditSettlementMode;
  autoRecover: boolean;
}

export interface ResolvedCreditCatalogRoute extends Omit<CreditCatalogRoute, 'charges'> {
  method: string;
  path: string;
  operation: string;
  boundary: boolean;
  charges: ResolvedCreditCatalogCharge[];
}

export class CreditCatalogMismatchException extends HttpException {
  constructor(message: string) {
    super(`Credit catalog mismatch: ${message}`, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

/** Normalizes, validates, and matches the one authoritative API price catalog. */
@Injectable()
export class CreditCatalogService {
  readonly serviceType: string;
  readonly version: string;
  readonly defaultVersion?: string;
  readonly routes: readonly ResolvedCreditCatalogRoute[];
  private readonly exactRoutes = new Map<string, ResolvedCreditCatalogRoute>();

  constructor(@Inject(CREDIT_OPTIONS) options: ResolvedCreditOptions) {
    const catalog = options.catalog;
    this.serviceType = required(catalog.serviceType, 'catalog.serviceType');
    this.version = required(catalog.version, 'catalog.version');
    if (catalog.versioning !== undefined &&
        catalog.versioning !== CreditCatalogVersioning.URI &&
        catalog.versioning !== CreditCatalogVersioning.NONE) {
      throw new TypeError('catalog.versioning must be URI or NONE');
    }
    this.defaultVersion = optional(catalog.defaultVersion);
    this.routes = catalog.routes.map((route, index) => this.resolveRoute(route, index));
    for (const route of this.routes) {
      const key = this.key(route.method, route.path);
      if (this.exactRoutes.has(key)) {
        throw new TypeError(`Duplicate credit catalog route ${key}`);
      }
      this.exactRoutes.set(key, route);
    }
  }

  find(method: string, requestPath: string): ResolvedCreditCatalogRoute | undefined {
    const normalizedMethod = method.toUpperCase();
    const pathname = normalizePath(requestPath.split('?')[0]);
    const exact = this.findExact(normalizedMethod, pathname);
    if (exact) return exact;
    const matches = this.routes.filter((route) =>
      route.method === normalizedMethod && matchesTemplate(route.path, pathname),
    );
    if (matches.length > 1) {
      throw new CreditCatalogMismatchException(
        `${normalizedMethod} ${pathname} matches multiple catalog routes`,
      );
    }
    return matches[0];
  }

  findExact(method: string, routePath: string): ResolvedCreditCatalogRoute | undefined {
    return this.exactRoutes.get(this.key(method, normalizePath(routePath)));
  }

  /** Returns the immutable subset of route charges applicable to this request. */
  forRequest(
    route: ResolvedCreditCatalogRoute,
    request: unknown,
  ): ResolvedCreditCatalogRoute {
    const charges = route.charges.filter((charge) =>
      !charge.when || matchesCondition(charge.when, request),
    );
    return charges.length === route.charges.length
      ? route
      : { ...route, charges };
  }

  private resolveRoute(route: CreditCatalogRoute, index: number): ResolvedCreditCatalogRoute {
    const method = required(route.method, `catalog.routes[${index}].method`).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL']
      .includes(method)) {
      throw new TypeError(`catalog.routes[${index}].method is not a supported HTTP method`);
    }
    const path = normalizePath(required(route.path, `catalog.routes[${index}].path`));
    const operation = route.operation?.trim() || `${method} ${path}`;
    const chargeIds = new Set<string>();
    const charges = route.charges.map((charge, chargeIndex) => {
      const field = `catalog.routes[${index}].charges[${chargeIndex}]`;
      const id = required(charge.id, `${field}.id`);
      if (chargeIds.has(id)) throw new TypeError(`Duplicate charge id ${id} on ${method} ${path}`);
      chargeIds.add(id);
      if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0) {
        throw new TypeError(`${field}.amount must be a positive safe integer`);
      }
      const creditType = required(charge.creditType, `${field}.creditType`);
      const settlementMode =
        charge.settlementMode ?? CreditSettlementMode.IMMEDIATE;
      const autoRecover = charge.autoRecover ?? true;
      if (!autoRecover && settlementMode !== CreditSettlementMode.DEFERRED) {
        throw new TypeError(`${field}.autoRecover=false requires DEFERRED settlement`);
      }
      const when = charge.when === undefined
        ? undefined
        : resolveCondition(charge.when, `${field}.when`);
      return { ...charge, id, creditType, settlementMode, autoRecover, when };
    });
    return { ...route, method, path, operation, boundary: route.boundary ?? false, charges };
  }

  private key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }
}

function resolveCondition(
  condition: CreditCatalogChargeCondition,
  field: string,
): CreditCatalogChargeCondition {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new TypeError(`${field} must be an object`);
  }
  if (condition.source !== 'body') {
    throw new TypeError(`${field}.source must be body`);
  }
  const path = required(condition.path, `${field}.path`);
  const segments = path.split('.');
  if (!segments.every(isSafePathSegment)) {
    throw new TypeError(`${field}.path must be a safe dot-separated property path`);
  }
  if (!['equals', 'notEquals', 'exists'].includes(condition.operator)) {
    throw new TypeError(`${field}.operator must be equals, notEquals, or exists`);
  }
  if (condition.operator === 'exists') {
    if (Object.prototype.hasOwnProperty.call(condition, 'value')) {
      throw new TypeError(`${field}.value must be omitted for exists`);
    }
  } else if (!Object.prototype.hasOwnProperty.call(condition, 'value') ||
      !isConditionValue(condition.value)) {
    throw new TypeError(
      `${field}.value must be a string, number, boolean, or null for ${condition.operator}`,
    );
  }
  return { ...condition, path };
}

function matchesCondition(
  condition: CreditCatalogChargeCondition,
  request: unknown,
): boolean {
  const body = isRecord(request) ? request.body : undefined;
  const result = readOwnPath(body, condition.path);
  if (condition.operator === 'exists') return result.exists;
  if (condition.operator === 'equals') return result.exists && Object.is(result.value, condition.value);
  return !result.exists || !Object.is(result.value, condition.value);
}

function readOwnPath(
  input: unknown,
  path: string,
): { exists: boolean; value?: unknown } {
  let value = input;
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return { exists: false };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePathSegment(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment) &&
    segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor';
}

function isConditionValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

export function defineCreditCatalog<T extends CreditCatalog>(catalog: T): T {
  return catalog;
}

export function normalizePath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('/')
    .replace(/\/+/, '/');
  const withLeadingSlash = `/${joined}`.replace(/\/+/g, '/');
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function matchesTemplate(template: string, pathname: string): boolean {
  const parts = template.split('/').map((part) => {
    if (part.startsWith(':')) return '[^/]+';
    if (part === '*') return '.*';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`).test(pathname);
}

function required(value: string | undefined, field: string): string {
  const result = value?.trim();
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}
