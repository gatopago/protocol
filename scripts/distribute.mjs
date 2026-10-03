import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copySdkRelease } from './pack-sdk.mjs';

const root = resolve(import.meta.dirname, '..');
const parent = resolve(root, '..');
const targets = [
  join(parent, 'gatopago', 'vendor'),
  join(parent, 'gatopago-wallet-core', 'vendor'),
  join(parent, 'gatopago-flow', 'vendor'),
];

console.log('1. Building SDK packages (shared, environment, test-fixtures)...');
execFileSync(process.execPath, [join(root, 'scripts/build-sdk.mjs')], { stdio: 'inherit', cwd: root });

console.log('2. Packing SDK tarballs...');
execFileSync(process.execPath, [join(root, 'scripts/pack-sdk.mjs')], { stdio: 'inherit', cwd: root });

console.log('3. Distributing tarballs to consumer projects...');
const releaseDir = join(root, 'output/sdk-releases');
const destinations = targets.filter(target => existsSync(resolve(target, '..')));
const release = copySdkRelease(releaseDir, destinations);
const files = release.packages.map(pkg => pkg.file);

for (const targetVendor of targets) {
  if (!existsSync(resolve(targetVendor, '..'))) {
    console.log(`Skipping non-existent repository: ${targetVendor}`);
    continue;
  }
  mkdirSync(targetVendor, { recursive: true });
  const consumer = JSON.parse(readFileSync(join(targetVendor, '..', 'package.json'), 'utf8'));
  const activeDependencies = new Set(Object.values({ ...consumer.dependencies,
    ...consumer.devDependencies, ...consumer.optionalDependencies }));
  for (const file of files) {
    const prefix = file.replace(/-\d+\.\d+\.\d+\.tgz$/, '');
    for (const oldFile of readdirSync(targetVendor).filter(f => f.startsWith(prefix) && f.endsWith('.tgz') && f !== file
      && !activeDependencies.has(`file:vendor/${f}`))) {
      unlinkSync(join(targetVendor, oldFile));
    }
    console.log(`  ✓ Verified ${file} -> ${targetVendor}`);
  }
}

console.log('\nDistribution complete! Remember to run "pnpm install" in the consumer repos if dependencies updated.');
