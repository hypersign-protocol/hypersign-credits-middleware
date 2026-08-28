#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = readJson(path.join(projectRoot, 'package.json'));
const profiles = {
  example: {
    catalog: 'src/catalogs/catalog.example.json',
    serviceType: 'EXAMPLE_API',
  },
  ssi: {
    catalog: 'src/catalogs/catalog.ssi.json',
    serviceType: 'SSI_API',
  },
  kyc: {
    catalog: 'src/catalogs/catalog.kyc.json',
    serviceType: 'CAVACH_API',
  },
};

main(process.argv.slice(2));

function main(argv) {
  const profileName = argv[0];
  const profile = profiles[profileName];
  if (!profile || argv.length !== 1) {
    throw new Error(`Usage: build-profile <${Object.keys(profiles).join('|')}>`);
  }

  const catalogPath = path.join(projectRoot, profile.catalog);
  const catalog = validateCatalog(readJson(catalogPath), profile.serviceType, catalogPath);
  const buildRoot = path.join(projectRoot, '.build', profileName);
  const packageRoot = path.join(buildRoot, 'package');
  const distRoot = path.join(packageRoot, 'dist');
  const packRoot = path.join(buildRoot, 'pack');

  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(distRoot, { recursive: true });
  run(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(projectRoot, 'tsconfig.json'),
    '--outDir', distRoot,
  ]);

  const distCatalogRoot = path.join(distRoot, 'catalogs');
  fs.rmSync(distCatalogRoot, { recursive: true, force: true });
  fs.mkdirSync(distCatalogRoot, { recursive: true });
  fs.copyFileSync(catalogPath, path.join(distCatalogRoot, 'catalog.json'));
  verifyRuntimeCatalog(distRoot, catalog);

  const stagedPackage = {
    ...packageJson,
    scripts: {},
    devDependencies: undefined,
    creditCatalogProfile: profileName,
    creditCatalogServiceType: catalog.serviceType,
  };
  writeJson(path.join(packageRoot, 'package.json'), stagedPackage);
  copyIfPresent(path.join(projectRoot, 'README.md'), path.join(packageRoot, 'README.md'));
  copyIfPresent(path.join(projectRoot, 'docs'), path.join(packageRoot, 'docs'));

  fs.mkdirSync(packRoot, { recursive: true });
  run('npm', ['pack', packageRoot, '--pack-destination', packRoot]);
  const sourceArtifact = path.join(
    packRoot,
    `${packageBase(packageJson.name)}-${packageJson.version}.tgz`,
  );
  if (!fs.existsSync(sourceArtifact)) {
    throw new Error(`npm pack did not create ${sourceArtifact}`);
  }
  const artifactName = `${packageBase(packageJson.name)}-${packageJson.version}-${profileName}.tgz`;
  const artifactPath = path.join(projectRoot, artifactName);
  fs.copyFileSync(sourceArtifact, artifactPath);
  verifyArtifact(artifactPath, profile.serviceType);
  process.stdout.write(
    `Built ${profileName} SDK (${catalog.routes.length} routes, ${catalog.serviceType}): ${artifactPath}\n`,
  );
}

function validateCatalog(catalog, expectedServiceType, file) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${file} must contain a catalog object`);
  }
  if (catalog.serviceType !== expectedServiceType) {
    throw new Error(`${file} must use serviceType ${expectedServiceType}`);
  }
  if (typeof catalog.version !== 'string' || !catalog.version.trim()) {
    throw new Error(`${file} must define a version`);
  }
  if (!Array.isArray(catalog.routes) || catalog.routes.length === 0) {
    throw new Error(`${file} must define at least one route`);
  }
  const routes = new Set();
  for (const route of catalog.routes) {
    const key = `${String(route.method).toUpperCase()} ${route.path}`;
    if (routes.has(key)) throw new Error(`${file} contains duplicate route ${key}`);
    routes.add(key);
    if (!Array.isArray(route.charges)) throw new Error(`${key} must define charges`);
    const ids = new Set();
    for (const charge of route.charges) {
      if (!charge.id || ids.has(charge.id)) throw new Error(`${key} has an invalid charge id`);
      ids.add(charge.id);
      if (!charge.creditType || !Number.isSafeInteger(charge.amount) || charge.amount <= 0) {
        throw new Error(`${key} has an invalid charge`);
      }
      if (charge.settlementMode !== undefined &&
          !['IMMEDIATE', 'DEFERRED'].includes(charge.settlementMode)) {
        throw new Error(`${key} has an invalid settlementMode`);
      }
      if (charge.autoRecover === false && charge.settlementMode !== 'DEFERRED') {
        throw new Error(`${key} autoRecover=false requires DEFERRED settlement`);
      }
      if (charge.when !== undefined) validateCondition(charge.when, `${key} ${charge.id}`);
    }
  }
  return catalog;
}

function validateCondition(condition, field) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new Error(`${field} has an invalid when condition`);
  }
  if (condition.source !== 'body') {
    throw new Error(`${field} when.source must be body`);
  }
  const path = typeof condition.path === 'string' ? condition.path.trim() : '';
  const safeSegments = path.split('.').every((segment) =>
    /^[A-Za-z0-9_-]+$/.test(segment) &&
    !['__proto__', 'prototype', 'constructor'].includes(segment));
  if (!path || !safeSegments) {
    throw new Error(`${field} has an invalid when.path`);
  }
  if (!['equals', 'notEquals', 'exists'].includes(condition.operator)) {
    throw new Error(`${field} has an invalid when.operator`);
  }
  const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value');
  if (condition.operator === 'exists') {
    if (hasValue) throw new Error(`${field} exists condition must omit value`);
    return;
  }
  const valueType = typeof condition.value;
  if (!hasValue || (condition.value !== null &&
      !['string', 'number', 'boolean'].includes(valueType)) ||
      (valueType === 'number' && !Number.isFinite(condition.value))) {
    throw new Error(`${field} has an invalid when.value`);
  }
}

function verifyArtifact(artifactPath, serviceType) {
  const listing = run('tar', ['-tzf', artifactPath]);
  const catalogs = listing.split(/\r?\n/).filter((entry) => entry.includes('/catalogs/'));
  if (catalogs.length !== 1 || catalogs[0] !== 'package/dist/catalogs/catalog.json') {
    throw new Error(`${artifactPath} must contain exactly one runtime catalog; found ${catalogs.join(', ')}`);
  }
  const bundled = JSON.parse(run('tar', [
    '-xOzf', artifactPath, 'package/dist/catalogs/catalog.json',
  ]));
  if (bundled.serviceType !== serviceType) {
    throw new Error(`${artifactPath} bundled ${bundled.serviceType}, expected ${serviceType}`);
  }
}

function verifyRuntimeCatalog(distRoot, expectedCatalog) {
  const modulePath = path.join(distRoot, 'credit.module.js');
  const { resolveCreditOptions } = require(modulePath);
  const resolved = resolveCreditOptions({ transport: false });
  if (resolved.catalog.serviceType !== expectedCatalog.serviceType) {
    throw new Error(
      `${modulePath} loaded ${resolved.catalog.serviceType}, expected ${expectedCatalog.serviceType}`,
    );
  }
  if (resolved.catalog.routes.length !== expectedCatalog.routes.length) {
    throw new Error(
      `${modulePath} loaded ${resolved.catalog.routes.length} routes, expected ${expectedCatalog.routes.length}`,
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: path.join(projectRoot, '.build', '.npm-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyIfPresent(source, target) {
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
}

function packageBase(name) {
  return name.replace(/^@/, '').replace(/\//g, '-');
}
