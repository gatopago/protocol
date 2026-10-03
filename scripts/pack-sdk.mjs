import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = process.env.npm_execpath;
assert(cli && /pnpm\.(?:m?js|cjs)$/.test(cli), 'Run pnpm sdk:pack');
const output = join(root, 'output/sdk-releases');
mkdirSync(output, { recursive: true });
const packages = [];
for (const directory of ['shared', 'environment', 'test-fixtures']) {
  const source = join(root, 'packages', directory), pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const exported of Object.values(pkg.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
    assert(existsSync(resolve(source, exported)), 'Build before pack');
  }
  const file = pkg.name.replace(/^@/, '').replace('/', '-') + '-' + pkg.version + '.tgz';
  execFileSync(process.execPath, [cli, '--dir', source, 'pack', '--pack-destination', output], { stdio: 'pipe' });
  const entries = execFileSync('tar', ['-tf', join(output, file)], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert(entries.every(entry => entry === 'package/package.json' || entry.startsWith('package/dist/')), 'Unexpected packed content');
  assert(!entries.some(entry => /(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|node_modules|\.git|\.wrangler)(?:\/|$)/.test(entry)), 'Private artifact in package');
  const packed = JSON.parse(execFileSync('tar', ['-xOf', join(output, file), 'package/package.json'], { encoding: 'utf8' }));
  assert(!JSON.stringify(packed).includes('workspace:'), 'Pack must resolve workspace dependencies');
  packages.push({ name: pkg.name, version: pkg.version, file,
    sha256: createHash('sha256').update(readFileSync(join(output, file))).digest('hex'), producer: `packages/${directory}` });
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schema_version: 1, packages }, null, 2) + '\n');
console.log('Packed immutable compiled SDK candidates; no registry publication or consumer changes.');
