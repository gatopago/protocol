import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
const files = readdirSync(releaseDir).filter(f => f.endsWith('.tgz'));

for (const targetVendor of targets) {
  if (!existsSync(resolve(targetVendor, '..'))) {
    console.log(`Skipping non-existent repository: ${targetVendor}`);
    continue;
  }
  mkdirSync(targetVendor, { recursive: true });
  for (const file of files) {
    copyFileSync(join(releaseDir, file), join(targetVendor, file));
    console.log(`  ✓ Copied ${file} -> ${targetVendor}`);
  }
}

console.log('\nDistribution complete! Remember to run "pnpm install" in the consumer repos if dependencies updated.');
