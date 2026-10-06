// Builds @gatopago/shared into packages/shared/dist/:
// ESM for every exported module (esbuild) and declarations (tsc).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

for (const name of ['shared']) {
  const source = join(root, 'packages', name);
  const dist = join(source, 'dist');
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const outputs = Object.values(pkg.exports).flatMap((value) =>
    typeof value === 'string' ? [value] : [value.import],
  );
  rmSync(dist, { recursive: true, force: true });

  await build({
    entryPoints: outputs
      .filter((file) => file.endsWith('.js'))
      .map((file) => join(source, file.replace('./dist/', '').replace(/\.js$/, '.ts'))),
    outdir: dist,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'warning',
  });
  for (const file of outputs.filter((file) => file.endsWith('.json'))) {
    cpSync(join(source, file.replace('./dist/', '')), join(source, file));
  }
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(source, 'tsconfig.build.json')],
    {
      stdio: 'inherit',
    },
  );

  // ESM consumers need explicit extensions in relative declaration imports.
  for (const file of readdirSync(dist).filter((file) => file.endsWith('.d.ts'))) {
    const path = join(dist, file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/(['"])(\.\/[^'"\n]+)\1/g, (original, quote, specifier) =>
        existsSync(resolve(dirname(path), `${specifier}.js`))
          ? `${quote}${specifier}.js${quote}`
          : original,
      ),
    );
  }
  for (const file of outputs) {
    if (!existsSync(join(source, file))) throw new Error(`Missing export ${pkg.name}: ${file}`);
  }
  // The published declarations must resolve on their own, as a consumer sees them.
  const declarations = readdirSync(dist).filter((file) => file.endsWith('.d.ts'));
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      ...[
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        'false',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
      ],
      ...['--target', 'es2022', '--resolveJsonModule', '--esModuleInterop', '--types', 'node'],
      ...declarations,
    ],
    { cwd: dist, stdio: 'inherit' },
  );
  console.log(`Built ${pkg.name}@${pkg.version}`);
}
