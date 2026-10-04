import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (['dist', 'node_modules'].includes(entry.name)) return [];
    const file = join(path, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
for (const name of ['shared', 'environment', 'test-fixtures']) {
  const source = join(root, 'packages', name),
    destination = resolve(source, 'dist');
  assert(
    destination === join(root, 'packages', name, 'dist'),
    'Build destination outside producer',
  );
  const inputs = files(source);

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  await build({
    entryPoints: inputs.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')),
    outbase: source,
    outdir: destination,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'warning',
  });
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(source, 'tsconfig.build.json')],
    { stdio: 'inherit' },
  );
  for (const input of inputs.filter(
    (file) =>
      ['.json', '.mjs', '.mts'].includes(extname(file)) &&
      !file.endsWith('package.json') &&
      !file.endsWith('tsconfig.build.json'),
  )) {
    const target = join(destination, relative(source, input));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(input, target);
  }

  const generated = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? generated(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  for (const file of generated(destination).filter((file) => file.endsWith('.d.ts'))) {
    const sourceText = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      sourceText.replace(/(['"])(\.{1,2}\/[^'"\n]+)\1/g, (original, quote, specifier) =>
        existsSync(resolve(dirname(file), specifier + '.js'))
          ? `${quote}${specifier}.js${quote}`
          : original,
      ),
    );
  }
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const exported of Object.values(pkg.exports).flatMap((value) =>
    typeof value === 'string' ? [value] : Object.values(value),
  )) {
    assert(existsSync(resolve(source, exported)), `Missing export ${name}: ${exported}`);
  }
  console.log(`Built ${pkg.name}@${pkg.version} ESM and declarations.`);
}
