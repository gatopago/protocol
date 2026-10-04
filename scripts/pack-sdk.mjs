import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sdkPackages = ['shared', 'environment', 'test-fixtures'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function readSdkRelease(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1, 'Unsupported SDK manifest');
  assert.equal(manifest.packages.length, sdkPackages.length, 'Incomplete SDK release');
  const names = new Set();
  for (const pkg of manifest.packages) {
    const name = pkg.name?.replace('@gatopago/', '');
    assert(sdkPackages.includes(name) && pkg.name === `@gatopago/${name}`, 'Unknown SDK package');
    assert(!names.has(name), 'Duplicate SDK package');
    names.add(name);
    assert(/^\d+\.\d+\.\d+$/.test(pkg.version), 'Invalid SDK version');
    assert.equal(pkg.file, `gatopago-${name}-${pkg.version}.tgz`, 'Invalid archive path');
    assert.equal(pkg.producer, `packages/${name}`, 'Invalid SDK producer');
    assert.equal(
      sha256(readFileSync(join(directory, pkg.file))),
      pkg.sha256,
      `Archive integrity: ${pkg.file}`,
    );
  }
  assert.equal(new Set(manifest.packages.map((pkg) => pkg.version)).size, 1, 'Mixed SDK versions');
  return manifest;
}

// Check all destinations before copying. A version retains its original bytes.
export function copySdkRelease(source, destinations) {
  const manifest = readSdkRelease(source);
  for (const destination of destinations) {
    for (const pkg of manifest.packages) {
      const target = join(destination, pkg.file);
      assert(
        !existsSync(target) || sha256(readFileSync(target)) === pkg.sha256,
        `SDK version collision: ${target}. Keep the existing archive and bump the producer version.`,
      );
    }
  }
  for (const destination of destinations) {
    mkdirSync(destination, { recursive: true });
    for (const pkg of manifest.packages) {
      const target = join(destination, pkg.file);
      if (!existsSync(target))
        copyFileSync(join(source, pkg.file), target, constants.COPYFILE_EXCL);
    }
  }
  return manifest;
}

export function promoteSdkRelease(source, destination) {
  const manifest = copySdkRelease(source, [destination]);
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const root = resolve(import.meta.dirname, '..');
export function sdkPnpm() {
  // Some script runners omit npm_execpath. Resolve pnpm's installed shim without a shell.
  const cli = [
    process.env.npm_execpath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .flatMap((directory) => [
        join(directory, 'node_modules/pnpm/bin/pnpm.cjs'),
        join(directory, 'pnpm'),
      ]),
  ]
    .filter((file) => file && existsSync(file))
    .map((file) => realpathSync(file))
    .find((file) => /pnpm\.(?:m?js|cjs)$/.test(file));
  assert(cli, 'Run the SDK commands with pnpm installed on PATH');
  const expectedVersion = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).packageManager.split('@')[1];
  const pnpmVersion = execFileSync(process.execPath, [cli, '--version'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(pnpmVersion, expectedVersion, 'Use the pinned pnpm version');
  return { cli, pnpmVersion };
}

function sourceInputs() {
  function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (['dist', 'node_modules'].includes(entry.name)) return [];
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
  }
  const paths = [
    ...sdkPackages.flatMap((name) => files(join(root, 'packages', name))),
    ...files(join(root, 'test')),
    ...[
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
      'scripts/build-sdk.mjs',
      'scripts/pack-sdk.mjs',
      'scripts/distribute.mjs',
      'scripts/check-sdk-consumer.mjs',
    ].map((path) => join(root, path)),
  ];
  return paths
    .map((path) => ({
      path: relative(root, path).split(sep).join('/'),
      sha256: sha256(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function packSdk() {
  const inputs = sourceInputs();
  const hasGit = existsSync(join(root, '.git'));
  const sourceHead = hasGit
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    : null;
  const dirty =
    !hasGit ||
    execFileSync('git', ['status', '--porcelain', '--', ...inputs.map((input) => input.path)], {
      cwd: root,
      encoding: 'utf8',
    }).trim().length > 0;
  const { cli, pnpmVersion } = sdkPnpm();
  const output = join(root, 'output/sdk-releases');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(root, 'output/sdk-pack-'));
  try {
    const packages = [];
    for (const directory of sdkPackages) {
      const source = join(root, 'packages', directory),
        pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      for (const exported of Object.values(pkg.exports).flatMap((value) =>
        typeof value === 'string' ? [value] : Object.values(value),
      )) {
        assert(existsSync(resolve(source, exported)), 'Build before pack');
      }
      const file = pkg.name.replace(/^@/, '').replace('/', '-') + '-' + pkg.version + '.tgz';
      execFileSync(
        process.execPath,
        [cli, '--dir', source, 'pack', '--pack-destination', staging],
        { stdio: 'pipe', cwd: root },
      );
      const entries = execFileSync('tar', ['-tf', join(staging, file)], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/);
      assert(
        entries.every(
          (entry) => entry === 'package/package.json' || entry.startsWith('package/dist/'),
        ),
        'Unexpected packed content',
      );
      assert(
        entries.every((entry) => !entry.split('/').includes('..') && !entry.includes('\\')),
        'Unsafe archive path',
      );
      assert(
        !entries.some((entry) =>
          /(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|node_modules|\.git|\.wrangler)(?:\/|$)/.test(
            entry,
          ),
        ),
        'Private artifact in package',
      );
      const packed = JSON.parse(
        execFileSync('tar', ['-xOf', join(staging, file), 'package/package.json'], {
          encoding: 'utf8',
        }),
      );
      assert.equal(packed.name, pkg.name);
      assert.equal(packed.version, pkg.version);
      assert(
        !JSON.stringify(packed).includes('workspace:'),
        'Pack must resolve workspace dependencies',
      );
      packages.push({
        name: pkg.name,
        version: pkg.version,
        file,
        sha256: sha256(readFileSync(join(staging, file))),
        producer: `packages/${directory}`,
      });
    }
    assert.deepEqual(sourceInputs(), inputs, 'SDK sources changed during packing');
    if (hasGit)
      assert.equal(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sourceHead,
        'Producer commit changed during packing',
      );
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify(
        {
          schema_version: 1,
          packages,
          pnpm_version: pnpmVersion,
          provenance: {
            git_head: sourceHead,
            source_dirty: dirty,
            source_tree_sha256: sha256(JSON.stringify(inputs)),
            source_inputs: inputs,
          },
        },
        null,
        2,
      ) + '\n',
    );
    promoteSdkRelease(staging, output);
    console.log(
      'Packed immutable compiled SDK candidates; no registry publication or consumer changes.',
    );
  } finally {
    assert(staging.startsWith(join(root, 'output') + sep), 'Staging cleanup outside output');
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packSdk();
