import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPinnedCreationProfile } from '../packages/shared/dist/v3/initialization.js';
import { deploymentDocumentDigest } from '../packages/shared/dist/v3/deployment.js';

const root = resolve(import.meta.dirname, '..'),
  contracts = resolve(root, 'contracts');
const sha = (text) => `0x${createHash('sha256').update(text).digest('hex')}`;
const fixture = JSON.parse(
  readFileSync(resolve(contracts, 'test/fixtures/money-arbitrum-sepolia-pins.json'), 'utf8'),
);
const accountDocument = JSON.stringify(fixture.account),
  account = loadPinnedCreationProfile(accountDocument, deploymentDocumentDigest(accountDocument));
// Public archive endpoint only. No signer, browser credential or deployment script.
const raw = execFileSync(
  'forge',
  ['test', '--match-contract', 'AccountV3MoneyPrograms(Fork|Golden)?Test', '--json'],
  {
    cwd: contracts,
    env: {
      ...process.env,
      ARBITRUM_SEPOLIA_RPC_URL: 'https://arbitrum-sepolia.gateway.tenderly.co',
    },
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
  },
);
const parsed = JSON.parse(raw.slice(raw.indexOf('{'))),
  tests = [];
for (const [suite, result] of Object.entries(parsed))
  for (const [name, test] of Object.entries(result.test_results)) {
    assert.equal(test.status, 'Success', `Composition test failed/skipped: ${suite}:${name}`);
    tests.push({
      suite,
      name,
      status: test.status,
      test_gas: test.kind.Unit.gas,
      measurements: test.decoded_logs.filter((log) => /UserOperation gas/.test(log)),
    });
  }
assert.equal(tests.length, 10, 'Unexpected composition test inventory');
const recipeLogs = tests.find(
  (test) => /ForkTest$/.test(test.suite) && /ThreeRecipes/.test(test.name),
)?.measurements;
assert.equal(recipeLogs?.length, 3, 'Missing measured per-recipe fork gas');
const gas = { aave_supply: '400000', aave_withdraw: '200000', aave_withdraw_and_pay: '250000' };
const report = {
  schema_version: 1,
  observed_at: new Date().toISOString(),
  status: 'local_and_pinned_fork_passed',
  execution: 'local_only',
  funding: 'synthetic_cheatcodes',
  p256: 'real_software_fallback_public_scalar_1',
  public_transactions: false,
  rpc_operator: 'tenderly',
  block_number: fixture.block_number,
  block_hash: fixture.block_hash,
  market_sha256: fixture.market_sha256,
  deployment_sha256: deploymentDocumentDigest(JSON.stringify(account.deployment)),
  compiler: { version: '0.8.34', optimizer_runs: 200, via_ir: true, evm_version: 'cancun' },
  sources: Object.fromEntries(
    [
      'test/AccountV3MoneyPrograms.t.sol',
      'test/AccountV3MoneyProgramsFork.t.sol',
      'test/AccountV3MoneyProgramsGolden.t.sol',
      'test/fixtures/money-programs-golden.json',
      'test/fixtures/money-arbitrum-sepolia-pins.json',
    ].map((path) => [path, sha(readFileSync(resolve(contracts, path)))]),
  ),
  tests,
  tested_limits: Object.fromEntries(
    Object.entries(gas).map(([kind, callGasLimit]) => [
      kind,
      {
        verificationGasLimit: '496000',
        callGasLimit,
        preVerificationGas: '100000',
        maxFeePerGas: '100000000',
        maxPriorityFeePerGas: '0',
      },
    ]),
  ),
  limitations: [
    'No public login, hardware passkey ceremony or relayer delivery is demonstrated.',
    'Foundry EVM gas does not replace a live Nitro outer-transaction/L1-fee quote.',
    'Exact signed simulation and fresh market/security/nonce/funding checks remain mandatory.',
  ],
};
const json = JSON.stringify(report, null, 2) + '\n';
writeFileSync(resolve(root, 'docs/arbitrum-delivery/money-composition.json'), json);
const policy = {
  schema_version: 1,
  money_schema_version: 1,
  network_id: 'eip155:421614',
  market_sha256: report.market_sha256,
  deployment_sha256: report.deployment_sha256,
  evidence_sha256: sha(json),
  valid_from: fixture.market.valid_from,
  valid_until: fixture.market.valid_until,
  limits: report.tested_limits,
};
writeFileSync(
  resolve(root, '../gatopago-wallet-core/config/money-gas.json'),
  JSON.stringify(policy, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    tests: tests.length,
    status: report.status,
    public_transactions: false,
    measurements: recipeLogs,
    evidence_sha256: sha(json),
  }),
);
