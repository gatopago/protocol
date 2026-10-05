// Upgrade safety for GatoPagoAccount (UUPS): every new implementation must keep the existing storage
// slots, offsets and types; new variables may only be appended.
//   node scripts/storage-layout.mjs          check against contracts/storage-layout.json
//   node scripts/storage-layout.mjs --write  record the current layout (after a reviewed upgrade)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const contracts = resolve(import.meta.dirname, '../contracts');
const snapshot = join(contracts, 'storage-layout.json');
const contract = 'src/wallet/GatoPagoAccount.sol:GatoPagoAccount';

const layout = JSON.parse(
  execFileSync('forge', ['inspect', contract, 'storageLayout', '--json'], {
    cwd: contracts,
    encoding: 'utf8',
  }),
);
const current = layout.storage.map(({ label, slot, offset, type }) => ({
  label,
  slot,
  offset,
  type: layout.types[type].label,
}));

if (process.argv.includes('--write') || !existsSync(snapshot)) {
  writeFileSync(snapshot, JSON.stringify({ [contract]: current }, null, 2) + '\n');
  console.log(`Recorded the storage layout of ${contract}.`);
} else {
  const recorded = JSON.parse(readFileSync(snapshot, 'utf8'))[contract];
  const broken = recorded.filter(
    (entry, index) => JSON.stringify(entry) !== JSON.stringify(current[index]),
  );
  if (broken.length) {
    console.error('Storage layout is not upgrade-compatible. Changed or removed:', broken);
    process.exit(1);
  }
  console.log(
    `Storage layout compatible (${recorded.length} recorded, ${current.length - recorded.length} appended).`,
  );
}
