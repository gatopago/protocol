import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const protocol = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(protocol, '..');
const sourceRoot =
  process.env.GATOPAGO_SDK_SOURCE ?? resolve(root, '../parmelia-links/parmelia-links');
const output = join(protocol, 'docs/arbitrum-delivery');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (path, ...args) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
const repos = [
  'gatopago',
  'gatopago-wallet-core',
  'gatopago-flow',
  'gatopago-dashboard',
  'protocol',
];
const sources = repos.map((name) => {
  const path = join(root, name);
  const status = git(path, 'status', '--porcelain');
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'vendor/manifest.json',
    'release.json',
    'src/runtime/catalog.ts',
    'src/runtime/config.ts',
    'src/index.ts',
    'contracts/package.json',
    'contracts/foundry.toml',
    'contracts/src/v3/AccountV3Execution.sol',
  ];
  return {
    repo: name,
    head: git(path, 'rev-parse', 'HEAD'),
    branch: git(path, 'branch', '--show-current'),
    pending_paths: status ? status.split('\n') : [],
    public_files: files
      .filter((file) => existsSync(join(path, file)))
      .map((file) => ({
        path: file,
        sha256: sha256(readFileSync(join(path, file))),
      })),
  };
});
const manifest = JSON.parse(
  readFileSync(join(root, 'gatopago-wallet-core/vendor/manifest.json'), 'utf8'),
);
const packages = manifest.packages.map((item) => {
  const archive = join(root, 'gatopago-wallet-core/vendor', item.file);
  const actualHash = sha256(readFileSync(archive));
  if (actualHash !== item.sha256) throw new Error(`Package integrity mismatch: ${item.name}`);
  if (!['shared', 'packages/environment', 'packages/test-fixtures'].includes(item.producer)) {
    return { ...item, archive_verified: true, source_comparison: 'separate-artifact-producer' };
  }
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const files = entries
    .filter((entry) => !entry.endsWith('/'))
    .map((entry) => {
      if (
        !entry.startsWith('package/') ||
        entry.includes('..') ||
        /(?:^|\/)\.(?:env|dev\.vars)/.test(entry)
      ) {
        throw new Error('Unsafe package entry');
      }
      const relative = entry.slice('package/'.length);
      const bytes = execFileSync('tar', ['-xOf', archive, entry], { maxBuffer: 20 * 1024 * 1024 });
      const source = join(sourceRoot, item.producer, relative);
      const sourceHash = existsSync(source) ? sha256(readFileSync(source)) : null;
      const metadataEquivalent =
        relative === 'package.json' &&
        sourceHash !== null &&
        isDeepStrictEqual(
          JSON.parse(bytes.toString('utf8')),
          JSON.parse(readFileSync(source, 'utf8')),
        );
      return {
        path: relative,
        archive_sha256: sha256(bytes),
        source_sha256: sourceHash,
        identical: sourceHash === sha256(bytes),
        ...(metadataEquivalent && sourceHash !== sha256(bytes)
          ? { transformation: 'pnpm-package-json-formatting', metadata_equivalent: true }
          : {}),
      };
    });
  return {
    ...item,
    archive_verified: true,
    source_comparison: files.every((file) => file.identical || file.metadata_equivalent)
      ? 'verified'
      : 'review-required',
    files,
  };
});
const source = {
  location: 'sibling parmelia-links/parmelia-links; override with GATOPAGO_SDK_SOURCE',
  head: git(sourceRoot, 'rev-parse', 'HEAD'),
  branch: git(sourceRoot, 'branch', '--show-current'),
};
const snapshot = {
  schema_version: 1,
  observed_at: new Date().toISOString(),
  repositories: sources,
  producer: source,
  packages,
};
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'sources.json'), JSON.stringify(snapshot, null, 2) + '\n');
const table = sources
  .map(
    (repo) => `| ${repo.repo} | \`${repo.head}\` | ${repo.branch} | ${repo.pending_paths.length} |`,
  )
  .join('\n');
const statusPath = join(output, 'STATUS.md');
if (!existsSync(statusPath))
  writeFileSync(
    statusPath,
    `# Estado de implementación Arbitrum

Línea base: ${snapshot.observed_at}. Fuente de detalle: [sources.json](sources.json).
El inventario no ejecuta pruebas, consultas de cadena ni despliegues.

| Repo | HEAD | Rama | Paths pendientes |
| --- | --- | --- | --- |
${table}

## Objetivos

| Objetivo | Estado | Evidencia pendiente |
| --- | --- | --- |
| O1 Recorrido básico | TODO | Login/passkey, activación, recepción, envío y receipt reales |
| O2 Operaciones compuestas | TODO | Supply, withdraw y withdraw-and-pay en la release pública |
| O3 Configuración | TODO | JSON/manifest con validación y secrets privados |
| O4 Paquetes | TODO | Productor, release registry e instalación limpia |
| O5 Permisos persistentes | Fuera de R1 | Especificación, release contractual y pruebas de la entrega R3 |

## Tareas

${Array.from({ length: 17 }, (_, n) => `- T${String(n).padStart(2, '0')}: ${n === 0 ? 'IN_PROGRESS — inventario capturado; revisar procedencia' : 'TODO'}`).join('\n')}

## Evidencia operacional

- Runtime local observado: Arbitrum Sepolia; self relayer; paymaster y sponsor de respaldo sin configurar.
- Credenciales: este inventario no lee ni valida secrets.
- Cuenta, sponsor, checkout, CCTP y Aave: sin evidencia nueva de ejecución pública en esta implementación.
- SDK: integridad de archives verificada; comparación de fuente registrada por archivo en sources.json.
- R1 conserva Consumer V3, passkeys y SPEND/ADMIN. R3 se registra por separado.

## Requisitos pendientes prioritarios

1. Admitir el mercado y obtener composición/liquidez al mismo bloque con dos RPC.
2. Verificar acceso real y cuenta de prueba con fondos para el recorrido base.
3. Coordinar reservas de las nuevas recetas con transferencias y probar recuperación.

Las autorizaciones de trabajo siguen las instrucciones actuales de Daniel. Esta tabla no presenta preparación local como prueba pública.
`,
  );
writeFileSync(
  join(protocol, 'ARBITRUM_DELIVERY_STATUS.md'),
  '# Entrega Arbitrum\n\nEstado y evidencia canónicos en [docs/arbitrum-delivery/STATUS.md](docs/arbitrum-delivery/STATUS.md).\n',
);
console.log(
  JSON.stringify(
    {
      observed_at: snapshot.observed_at,
      repositories: sources.length,
      packages: packages.map((item) => ({
        name: item.name,
        archive_verified: item.archive_verified,
        source_comparison: item.source_comparison,
      })),
    },
    null,
    2,
  ),
);
