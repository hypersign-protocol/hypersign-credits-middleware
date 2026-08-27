import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  RequestMethod,
} from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { CreditCatalogService, normalizePath } from './credit.catalog';
import { CreditCatalogVersioning } from './credit.enums';
import { CREDIT_OPTIONS, ResolvedCreditOptions } from './credit.types';
import { Inject } from '@nestjs/common';

interface DiscoveredRoute { method: string; path: string }

/** Fails Nest startup when application routes and the selected catalog drift. */
@Injectable()
export class CreditCatalogAuditor implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditCatalogAuditor.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly catalog: CreditCatalogService,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
  ) {}

  onApplicationBootstrap(): void {
    const discovered = this.discoverRoutes();
    const discoveredKeys = discovered.map((route) => key(route));
    const applicationKeys = new Set(discoveredKeys);
    const catalogKeys = new Set(this.catalog.routes.map((route) => key(route)));
    const duplicates = [...applicationKeys].filter((value) =>
      discoveredKeys.filter((candidate) => candidate === value).length > 1,
    );
    const missingFromCatalog = [...applicationKeys].filter((value) => !catalogKeys.has(value));
    const missingFromApplication = [...catalogKeys].filter((value) => !applicationKeys.has(value));
    if (duplicates.length || missingFromCatalog.length || missingFromApplication.length) {
      const details = [
        ...duplicates.map((value) => `duplicate application route: ${value}`),
        ...missingFromCatalog.map((value) => `application route missing from catalog: ${value}`),
        ...missingFromApplication.map((value) => `catalog route missing from application: ${value}`),
      ];
      throw new TypeError(`Credit catalog route audit failed:\n- ${details.join('\n- ')}`);
    }
    this.logger.log(
      `Validated ${applicationKeys.size} route(s) against credit catalog ` +
      `${this.catalog.serviceType}@${this.catalog.version}`,
    );
  }

  private discoverRoutes(): DiscoveredRoute[] {
    const discovered: DiscoveredRoute[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype;
      const instance = wrapper.instance as object | undefined;
      if (!metatype || !instance) continue;
      const controllerPaths = values<string>(Reflect.getMetadata(PATH_METADATA, metatype), '');
      const controllerVersions = values<string | symbol>(
        Reflect.getMetadata(VERSION_METADATA, metatype),
        this.catalog.defaultVersion,
      );
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (requestMethod === undefined) continue;
        const method = RequestMethod[requestMethod];
        const methodPaths = values<string>(Reflect.getMetadata(PATH_METADATA, handler), '');
        const methodVersion = Reflect.getMetadata(VERSION_METADATA, handler) as
          | string | symbol | Array<string | symbol> | undefined;
        const versions = methodVersion === undefined
          ? controllerVersions
          : values<string | symbol>(methodVersion, undefined);
        for (const controllerPath of controllerPaths) {
          for (const methodPath of methodPaths) {
            for (const version of versions) {
              const versionPath = typeof version === 'string' &&
                (this.options.catalog.versioning ?? CreditCatalogVersioning.URI) ===
                  CreditCatalogVersioning.URI
                ? `${this.options.catalog.uriVersionPrefix ?? 'v'}${version}`
                : undefined;
              discovered.push({
                method,
                path: normalizePath(
                  this.options.catalog.globalPrefix,
                  versionPath,
                  controllerPath,
                  methodPath,
                ),
              });
            }
          }
        }
      }
    }
    return discovered;
  }
}

function values<T>(value: T | T[] | undefined, fallback: T | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value !== undefined) return [value];
  return fallback === undefined ? [undefined as T] : [fallback];
}

function key(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${normalizePath(route.path)}`;
}
