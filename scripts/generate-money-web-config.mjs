import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deploymentDocumentDigest } from '../packages/shared/dist/v3/deployment.js';
import { loadAaveMarket } from '../packages/shared/dist/v3/aaveMarket.js';

// Public reviewed artifacts only. No environment files, secrets or RPC reads.
const root = resolve(import.meta.dirname, '..');
const marketDocument = JSON.stringify(
  JSON.parse(
    await readFile(
      resolve(root, '../gatopago-wallet-core/config/markets/aave-v3-arbitrum-sepolia-usdc.json'),
      'utf8',
    ),
  ),
);
const market = { document: marketDocument, digest: deploymentDocumentDigest(marketDocument) };
loadAaveMarket(market);
const gas = JSON.parse(
  await readFile(resolve(root, '../gatopago-wallet-core/config/money-gas.json'), 'utf8'),
);
if (
  gas.schema_version !== 1 ||
  gas.money_schema_version !== 1 ||
  gas.market_sha256 !== market.digest
)
  throw new Error('MONEY_WEB_CONFIGURATION');
const evidence = await readFile(
  resolve(root, 'docs/arbitrum-delivery/money-composition.json'),
  'utf8',
);
if (deploymentDocumentDigest(evidence) !== gas.evidence_sha256)
  throw new Error('MONEY_WEB_EVIDENCE');
const output = `${JSON.stringify({ schema_version: 1, market, gas }, null, 2)}\n`;
const directory = resolve(root, '../gatopago/config'),
  target = resolve(directory, 'money-release.json');
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== output) throw new Error('MONEY_WEB_CONFIGURATION_STALE');
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(target, output);
}
console.log(
  JSON.stringify({
    status: process.argv.includes('--check') ? 'verified' : 'generated',
    market_sha256: market.digest,
    evidence_sha256: gas.evidence_sha256,
  }),
);
