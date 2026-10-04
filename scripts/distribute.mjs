import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { archiveUnusedSdk, copySdkRelease, sdkPnpm } from './pack-sdk.mjs';

const root = resolve(import.meta.dirname, '..');
const parent = resolve(root, '..');
const consumers = ['gatopago-wallet-core', 'gatopago', 'gatopago-flow'];
const args = process.argv.slice(2);
assert(
  args.length === 0 ||
    (args.length === 2 && args[0] === '--consumer' && consumers.includes(args[1])),
  `Usage: pnpm distribute [--consumer ${consumers.join('|')}]`,
);
const selected = args.length === 0 ? consumers : [args[1]];
const destinations = selected
  .map((name) => join(parent, name))
  .filter((directory) => existsSync(join(directory, 'package.json')));
assert(destinations.length > 0, 'No selected consumer repositories found');

console.log('Building and packing the internal SDK...');
for (const script of ['build-sdk.mjs', 'pack-sdk.mjs']) {
  execFileSync(process.execPath, [join(root, 'scripts', script)], {
    stdio: 'inherit',
    cwd: root,
  });
}

const release = copySdkRelease(
  join(root, 'output/sdk-releases'),
  destinations.map((directory) => join(directory, 'vendor')),
);
const { cli } = sdkPnpm();

for (const directory of destinations) {
  console.log(`Updating ${directory}...`);
  const packagePath = join(directory, 'package.json');
  const originalPackage = readFileSync(packagePath, 'utf8');
  const consumer = JSON.parse(originalPackage);
  assert.equal(consumer.private, true, 'SDK consumers must remain private');
  const workspacePath = join(directory, 'pnpm-workspace.yaml');
  const originalWorkspace = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : null;
  let workspace = originalWorkspace;
  let changed = false;

  for (const pkg of release.packages) {
    const reference = `file:vendor/${pkg.file}`;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (consumer[group]?.[pkg.name] !== undefined && consumer[group][pkg.name] !== reference) {
        consumer[group][pkg.name] = reference;
        changed = true;
      }
    }

    if (workspace !== null) {
      const name = pkg.name.slice('@gatopago/'.length);
      workspace = workspace
        .replaceAll(new RegExp(`(@gatopago/${name})@\\d+\\.\\d+\\.\\d+`, 'g'), `$1@${pkg.version}`)
        .replaceAll(
          new RegExp(`file:vendor/gatopago-${name}-\\d+\\.\\d+\\.\\d+\\.tgz`, 'g'),
          reference,
        );
    }
  }

  if (changed) writeFileSync(packagePath, JSON.stringify(consumer, null, 2) + '\n');
  if (workspace !== originalWorkspace) writeFileSync(workspacePath, workspace);
  if (changed || workspace !== originalWorkspace) {
    execFileSync(process.execPath, [cli, 'install', '--lockfile-only', '--ignore-scripts'], {
      cwd: directory,
      stdio: 'inherit',
      timeout: 120_000,
    });
  }
  execFileSync(process.execPath, [cli, 'install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 120_000,
  });
  writeFileSync(
    join(directory, 'vendor', 'sdk-manifest.json'),
    JSON.stringify(release, null, 2) + '\n',
  );
  const archived = archiveUnusedSdk(directory, release);
  console.log(`Archived ${archived.length} unused SDK snapshots in vendor/archive/.`);
  console.log(`Installed SDK ${release.packages[0].version} with a frozen lockfile.`);
}

console.log('Internal SDK distribution complete. Previous archives are retained for rollback.');
