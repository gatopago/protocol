import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readSdkRelease, sdkPnpm, sha256 } from './pack-sdk.mjs';

const root = resolve(import.meta.dirname, '..');
const releaseDirectory = join(root, 'output/sdk-releases');
const release = readSdkRelease(releaseDirectory);
const toolchain = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { cli, pnpmVersion } = sdkPnpm();
const consumer = mkdtempSync(join(tmpdir(), 'gatopago-sdk-consumer-'));

try {
  const vendor = join(consumer, 'vendor');
  mkdirSync(vendor);
  const dependencies = {};
  const exports = [];
  for (const pkg of release.packages) {
    const archive = join(releaseDirectory, pkg.file);
    copyFileSync(archive, join(vendor, pkg.file));
    dependencies[pkg.name] = `file:vendor/${pkg.file}`;
    const packed = JSON.parse(
      execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.equal(packed.name, pkg.name);
    assert.equal(packed.version, pkg.version);
    for (const [subpath, target] of Object.entries(packed.exports)) {
      assert(subpath === '.' || /^\.\/[a-zA-Z0-9/._-]+$/.test(subpath), 'Invalid export subpath');
      const path = typeof target === 'string' ? target : (target.import ?? target.default);
      assert(
        typeof path === 'string' && path.startsWith('./dist/'),
        'Expected compiled ESM export',
      );
      exports.push({
        specifier: pkg.name + (subpath === '.' ? '' : subpath.slice(1)),
        json: path.endsWith('.json'),
      });
    }
  }

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'gatopago-isolated-sdk-consumer',
        private: true,
        type: 'module',
        packageManager: toolchain.packageManager,
        dependencies,
        devDependencies: {
          typescript: toolchain.devDependencies.typescript,
          '@types/node': toolchain.devDependencies['@types/node'],
          vitest: toolchain.devDependencies.vitest,
        },
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    'packages: []\nignoreScripts: true\nenableGlobalVirtualStore: false\noverrides:\n' +
      Object.entries(dependencies)
        .map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}\n`)
        .join(''),
  );

  const install = (args) =>
    execFileSync(process.execPath, [cli, 'install', ...args, '--ignore-scripts'], {
      cwd: consumer,
      stdio: 'pipe',
      timeout: 120000,
    });
  assert(
    !existsSync(join(consumer, 'node_modules')),
    'Consumer must start without installed dependencies',
  );
  console.log('Resolving an isolated SDK consumer lockfile...');
  install(['--lockfile-only']);
  assert(
    !existsSync(join(consumer, 'node_modules')),
    'Lockfile generation must not create node_modules',
  );
  console.log('Installing the isolated consumer with its frozen lockfile...');
  install(['--frozen-lockfile']);

  writeFileSync(join(consumer, 'exports.json'), JSON.stringify(exports));
  writeFileSync(
    join(consumer, 'check.mjs'),
    `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
const require = createRequire(import.meta.url);
const entries = JSON.parse(readFileSync(new URL('./exports.json', import.meta.url)));
for (const entry of entries) {
  const resolved = realpathSync(require.resolve(entry.specifier));
  assert(resolved.startsWith(resolve('node_modules') + sep), 'SDK resolved outside the independent consumer');
  await import(entry.specifier, entry.json ? { with: { type: 'json' } } : undefined);
  require(entry.specifier);
}
console.log(JSON.stringify({ esm_exports: entries.length, require_exports: entries.length }));
`,
  );
  const runtime = JSON.parse(
    execFileSync(process.execPath, ['check.mjs'], { cwd: consumer, encoding: 'utf8' }),
  );

  writeFileSync(
    join(consumer, 'types.mts'),
    exports
      .map(
        (entry, index) =>
          `import * as module${index} from ${JSON.stringify(entry.specifier)}${entry.json ? ' with { type: "json" }' : ''};\nvoid module${index};`,
      )
      .join('\n') + '\n',
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          resolveJsonModule: true,
          types: ['node'],
          lib: ['ES2022', 'DOM'],
        },
        include: ['types.mts'],
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: consumer, stdio: 'inherit', timeout: 120000 },
  );

  const installed = release.packages.map((pkg) => {
    const metadata = JSON.parse(
      readFileSync(join(consumer, 'node_modules', pkg.name, 'package.json'), 'utf8'),
    );
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    assert.equal(sha256(readFileSync(join(vendor, pkg.file))), pkg.sha256);
    return { name: pkg.name, version: pkg.version, sha256: pkg.sha256 };
  });
  const report = {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    status: 'isolated_compiled_consumer_passed',
    node: process.version,
    pnpm: pnpmVersion,
    typescript: toolchain.devDependencies.typescript,
    ...runtime,
    strict_nodenext_types: true,
    frozen_install: true,
    inherited_node_modules: false,
    producer_source_aliases: false,
    local_tarball_overrides: true,
    registry_publication: false,
    registry_sdk_installation: false,
    consumer_lockfile_sha256: sha256(readFileSync(join(consumer, 'pnpm-lock.yaml'))),
    packages: installed,
  };
  writeFileSync(
    join(releaseDirectory, 'consumer-local.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  assert.equal(
    dirname(resolve(consumer)),
    resolve(tmpdir()),
    'Cleanup outside the temporary directory',
  );
  assert(basename(consumer).startsWith('gatopago-sdk-consumer-'), 'Unexpected cleanup target');
  rmSync(consumer, { recursive: true, force: true });
}
