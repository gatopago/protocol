import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeAbiParameters, getAddress, parseAbiParameters } from 'viem';
import { prepareMoneyOperation } from '../packages/shared/dist/v3/moneyOperation.js';
import { parseMoneyRequest } from '../packages/shared/dist/v3/moneyWire.js';
import { parseAaveMarket } from '../packages/shared/dist/v3/aaveMarket.js';
import { authorizationTypes } from '../packages/shared/dist/v3/authorizations.js';
import { deploymentDocumentDigest } from '../packages/shared/dist/v3/deployment.js';

const root = resolve(import.meta.dirname, '..'),
  hash = (c) => `0x${c.repeat(64)}`;
const creationDocument = readFileSync(
  resolve(root, 'packages/shared/dist/v3/arbitrum-sepolia-creation.json'),
  'utf8',
);
const profile = JSON.parse(creationDocument),
  marketDocument = readFileSync(
    resolve(root, '../gatopago-wallet-core/config/markets/aave-v3-arbitrum-sepolia-usdc.json'),
    'utf8',
  );
const market = parseAaveMarket(JSON.parse(marketDocument));
const pins = {
  schema_version: 1,
  purpose: 'local_pinned_fork_only',
  funding: 'synthetic_cheatcodes',
  block_number: Number(market.admitted_block_number),
  block_tag: `0x${BigInt(market.admitted_block_number).toString(16)}`,
  block_hash: market.admitted_block_hash,
  market_sha256: deploymentDocumentDigest(JSON.stringify(JSON.parse(marketDocument))),
  creation_sha256: deploymentDocumentDigest(creationDocument),
  account: profile,
  market,
};
writeFileSync(
  resolve(root, 'contracts/test/fixtures/money-arbitrum-sepolia-pins.json'),
  JSON.stringify(pins, null, 2) + '\n',
);

// Fixed unsigned synthetic vectors have no session, secret or reusable proof.
const syntheticMarket = {
  ...market,
  valid_from: 900,
  valid_until: 2000,
  admitted_block_number: '100',
  admitted_block_hash: hash('c'),
};
const document = JSON.stringify(syntheticMarket),
  walletId = 'wal_11111111-1111-4111-8111-111111111111';
const accountId = 'wac_22222222-2222-4222-8222-222222222222';
const context = {
  account: getAddress(`0x${'1'.repeat(40)}`),
  wallet_account_id: accountId,
  account_id: hash('1'),
  deployment_digest: hash('2'),
  policy_hash: hash('3'),
  security_version: 2n,
  entry_point: getAddress(`0x${'3'.repeat(40)}`),
  nonce: 7n,
  market: { document, digest: deploymentDocumentDigest(document) },
  native_asset_id: 'eip155:421614/slip44:60',
  gas: {
    verificationGasLimit: 496000n,
    callGasLimit: 400000n,
    preVerificationGas: 100000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 0n,
  },
  budget: {
    usdc_available_atomic: '100000000',
    position_available_atomic: '50000000',
    native_available_atomic: '1000000000000000000',
    maximum_native_gas_atomic: '99600000000000',
    debt_base_atomic: '0',
    liquidity_atomic: '1000000000',
    supply_capacity_atomic: null,
  },
  checkpoint: { block_number: '101', block_hash: hash('e'), observed_at: 1000, expires_at: 1030 },
  valid_until: 1020,
};
const vectors = ['aave_supply', 'aave_withdraw', 'aave_withdraw_and_pay'].map((kind) => {
  const request = parseMoneyRequest({
    schema_version: 1,
    kind,
    wallet_id: walletId,
    wallet_account_id: accountId,
    network_id: market.network_id,
    market_id: market.market_id,
    asset_id: market.asset_id,
    amount_atomic: '20000000',
    client_release_id: 'synthetic-money-golden-1',
    ...(kind === 'aave_withdraw_and_pay'
      ? { recipient_address: getAddress(`0x${'2'.repeat(40)}`) }
      : {}),
  });
  const candidate = prepareMoneyOperation(request, context, 1000);
  return {
    request,
    context,
    now: 1000,
    account: candidate.account,
    calldata: candidate.operation.callData,
    calls_abi: encodeAbiParameters(
      parseAbiParameters('(address target,uint256 value,bytes data)[]'),
      [candidate.calls],
    ),
    plan_abi: encodeAbiParameters(
      [{ type: 'tuple', components: authorizationTypes.ExecutionPlan }],
      [candidate.plan],
    ),
    calls_hash: candidate.calls_hash,
    userop_hash: candidate.userOpHash,
    consent_digest: candidate.digest,
    asset_limits_hash: candidate.plan.assetLimitsHash,
    fee_policy_hash: candidate.plan.feePolicyHash,
    preview_hash: candidate.plan.previewHash,
  };
});
writeFileSync(
  resolve(root, 'contracts/test/fixtures/money-programs-golden.json'),
  JSON.stringify(
    { schema_version: 1, purpose: 'unsigned_synthetic_cross_language_vectors', vectors },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  ) + '\n',
);
console.log(
  'Generated public pinned fork configuration and 3 fixed unsigned cross-language vectors.',
);
