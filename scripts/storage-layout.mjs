// Upgrade safety for GatoPagoAccount (UUPS): every new implementation must keep the existing storage
// slots, offsets and types, down to the members of each struct; new variables may only be appended.
// The ERC-7201 slots the account reads by hand (`*_SLOT` constants) must not change either.
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

/** A type with everything that fixes its storage, members and element types included. */
function describe(id) {
  const { label, numberOfBytes, encoding, members, key, value, base } = layout.types[id];
  return {
    label,
    numberOfBytes,
    encoding,
    ...(members && { members: members.map(entry) }),
    ...(key && { key: describe(key) }),
    ...(value && { value: describe(value) }),
    ...(base && { base: describe(base) }),
  };
}
const entry = ({ label, slot, offset, type }) => ({ label, slot, offset, type: describe(type) });

const source = readFileSync(join(contracts, contract.split(':')[0]), 'utf8');
const current = {
  storage: layout.storage.map(entry),
  slots: Object.fromEntries(
    [...source.matchAll(/bytes32 private constant (\w+_SLOT) =\s*(0x[0-9a-fA-F]{64});/g)].map(
      ([, name, slot]) => [name, slot.toLowerCase()],
    ),
  ),
};

if (process.argv.includes('--write')) {
  writeFileSync(snapshot, JSON.stringify({ [contract]: current }, null, 2) + '\n');
  console.log(`Recorded the storage layout of ${contract}.`);
} else {
  if (!existsSync(snapshot)) {
    console.error(`No recorded layout: review it, then run with --write (${snapshot}).`);
    process.exit(1);
  }
  const recorded = JSON.parse(readFileSync(snapshot, 'utf8'))[contract];
  const broken = recorded.storage.filter(
    (field, index) => JSON.stringify(field) !== JSON.stringify(current.storage[index]),
  );
  const moved = Object.entries(recorded.slots).filter(
    ([name, slot]) => current.slots[name] !== slot,
  );
  if (broken.length || moved.length) {
    console.error('Storage layout is not upgrade-compatible. Changed or removed:', {
      storage: broken,
      slots: moved,
    });
    process.exit(1);
  }
  console.log(
    `Storage layout compatible (${recorded.storage.length} fields and ` +
      `${Object.keys(recorded.slots).length} manual slots recorded, ` +
      `${current.storage.length - recorded.storage.length} fields appended).`,
  );
}
