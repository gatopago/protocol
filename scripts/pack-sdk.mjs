import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { promoteSdkRelease, sdkPackages, sha256 } from './sdk-release.mjs';

const root = resolve(import.meta.dirname, '..');
// Some script runners omit npm_execpath. Resolve pnpm's installed shim without a shell.
const cli = [process.env.npm_execpath,
  ...(process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'node_modules/pnpm/bin/pnpm.cjs'))]
  .find(file => file && /pnpm\.(?:m?js|cjs)$/.test(file) && existsSync(file));
assert(cli, 'Run pnpm pack with pnpm installed on PATH');
const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager.split('@')[1];
const pnpmVersion = execFileSync(process.execPath, [cli, '--version'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(pnpmVersion, expectedVersion, 'Use the pinned pnpm version');
const output = join(root, 'output/sdk-releases');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(root, 'output/sdk-pack-'));
try {
const packages = [];
for (const directory of sdkPackages) {
  const source = join(root, 'packages', directory), pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const exported of Object.values(pkg.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
    assert(existsSync(resolve(source, exported)), 'Build before pack');
  }
  const file = pkg.name.replace(/^@/, '').replace('/', '-') + '-' + pkg.version + '.tgz';
  execFileSync(process.execPath, [cli, '--dir', source, 'pack', '--pack-destination', staging], { stdio: 'pipe', cwd: root });
  const entries = execFileSync('tar', ['-tf', join(staging, file)], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert(entries.every(entry => entry === 'package/package.json' || entry.startsWith('package/dist/')), 'Unexpected packed content');
  assert(entries.every(entry => !entry.split('/').includes('..') && !entry.includes('\\')), 'Unsafe archive path');
  assert(!entries.some(entry => /(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|node_modules|\.git|\.wrangler)(?:\/|$)/.test(entry)), 'Private artifact in package');
  const packed = JSON.parse(execFileSync('tar', ['-xOf', join(staging, file), 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(packed.name, pkg.name); assert.equal(packed.version, pkg.version);
  assert(!JSON.stringify(packed).includes('workspace:'), 'Pack must resolve workspace dependencies');
  packages.push({ name: pkg.name, version: pkg.version, file,
    sha256: sha256(readFileSync(join(staging, file))), producer: `packages/${directory}` });
}
writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ schema_version: 1, packages, pnpm_version: pnpmVersion }, null, 2) + '\n');
promoteSdkRelease(staging, output);
console.log('Packed immutable compiled SDK candidates; no registry publication or consumer changes.');
} finally {
  assert(staging.startsWith(join(root, 'output') + sep), 'Staging cleanup outside output');
  rmSync(staging, { recursive: true, force: true });
}
