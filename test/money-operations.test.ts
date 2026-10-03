import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { aavePoolAbi, parseAaveMarket } from '../packages/shared/dist/v3/aaveMarket.js';
import { deploymentDocumentDigest } from '../packages/shared/dist/v3/deployment.js';
import { parseMoneyRequest, type MoneyKind } from '../packages/shared/dist/v3/moneyWire.js';
import { prepareMoneyOperation, type MoneyOperationContext } from '../packages/shared/dist/v3/moneyOperation.js';
import { readMoneyDraft, readMoneyReview, writeMoneyDraft, writeMoneyReview } from '../packages/shared/dist/v3/moneyReviewRecord.js';
import { hashSecurityPolicy, type SecurityPolicy } from '../packages/shared/dist/v3/securityPolicy.js';
import { initializationFixture } from '../packages/test-fixtures/v3Initialization';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const wallet = 'wal_11111111-1111-4111-8111-111111111111';
const accountId = 'wac_22222222-2222-4222-8222-222222222222';
const token = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const pool = '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff';
function fixture(kind: MoneyKind = 'aave_withdraw_and_pay') {
  const market = parseAaveMarket({ schema_version: 1, market_id: 'aave-v3-arbitrum-sepolia-usdc', network_id: 'eip155:421614',
    asset_id: 'eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', decimals: 6,
    provider: '0xB25a5D144626a0D488e52AE717A051a2E9997076', pool, a_token: '0x460b97BD498E1157530AEb3086301d5225b91216',
    genesis_hash: hash('a'), abi_sha256: hash('b'), admitted_block_number: '100', admitted_block_hash: hash('c'),
    valid_from: 900, valid_until: 2000, max_observation_age_seconds: 30,
    contracts: Object.entries({ provider: '0xB25a5D144626a0D488e52AE717A051a2E9997076', pool, token,
      a_token: '0x460b97BD498E1157530AEb3086301d5225b91216' }).map(([name, value]) => ({ name, address: value,
      code_hash: hash('d'), implementation: null, implementation_code_hash: null })) });
  const document = JSON.stringify(market);
  const request = parseMoneyRequest({ schema_version: 1, kind, wallet_id: wallet, wallet_account_id: accountId,
    network_id: market.network_id, market_id: market.market_id, asset_id: market.asset_id, amount_atomic: '20000000',
    client_release_id: 'money-test-1', ...(kind === 'aave_withdraw_and_pay' ? { recipient_address: address('2') } : {}) });
  const context: MoneyOperationContext = { account: address('1'), wallet_account_id: request.wallet_account_id, account_id: hash('1'),
    deployment_digest: hash('2'), policy_hash: hash('3'), security_version: 2n, entry_point: address('3'), nonce: 0n,
    market: { document, digest: deploymentDocumentDigest(document) }, native_asset_id: 'eip155:421614/slip44:60',
    gas: { verificationGasLimit: 100n, callGasLimit: 200n, preVerificationGas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 0n },
    budget: { usdc_available_atomic: '100000000', position_available_atomic: '50000000', native_available_atomic: '10000',
      maximum_native_gas_atomic: '1000', debt_base_atomic: '0', liquidity_atomic: '1000000000', supply_capacity_atomic: null },
    checkpoint: { block_number: '101', block_hash: hash('e'), observed_at: 1000, expires_at: 1030 }, valid_until: 1020 };
  return { request, context, now: 1000 };
}

describe('closed money recipes through the compiled SDK', () => {
  it('deposits for the account itself with exact approval and zero residual allowance', () => {
    const f = fixture('aave_supply'), operation = prepareMoneyOperation(f.request, f.context, f.now);
    expect(operation.calls).toHaveLength(4);
    const approvals = [0, 1, 3].map(index => decodeFunctionData({ abi: erc20Abi, data: operation.calls[index].data }));
    expect(approvals.map(call => call.functionName)).toEqual(['approve', 'approve', 'approve']);
    expect(approvals.map(call => call.args)).toEqual([[pool, 0n], [pool, 20000000n], [pool, 0n]]);
    expect(operation.calls.map(call => call.target)).toEqual([token, token, pool, token]);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: operation.calls[2].data }).args).toEqual([token, 20000000n, address('1'), 0]);
    expect(operation.funding).toMatchObject({ asset_debit_atomic: '20000000', position_debit_atomic: '0' });
  });
  it('withdraws only into the account', () => {
    const f = fixture('aave_withdraw'), operation = prepareMoneyOperation(f.request, f.context, f.now);
    expect(operation.calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: operation.calls[0].data })).toMatchObject({ functionName: 'withdraw', args: [token, 20000000n, address('1')] });
    expect(operation.funding).toMatchObject({ asset_debit_atomic: '0', position_debit_atomic: '20000000' });
  });
  it('withdraws and pays exactly the same amount in one UserOperation', () => {
    const f = fixture(), operation = prepareMoneyOperation(f.request, f.context, f.now);
    expect(operation.calls).toHaveLength(2);
    expect(operation.calls[0].target).toBe(pool);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: operation.calls[0].data }).args).toEqual([token, 20000000n, address('1')]);
    expect(decodeFunctionData({ abi: erc20Abi, data: operation.calls[1].data })).toMatchObject({ functionName: 'transfer', args: [address('2'), 20000000n] });
    expect(operation.plan.paymaster).toBe('0x0000000000000000000000000000000000000000');
    expect(operation.operation.signature).toBe('0x');
  });
  it('reconstructs equal hashes despite JSON property order', () => {
    const f = fixture(), original = prepareMoneyOperation(f.request, f.context, f.now);
    const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
    const candidate = prepareMoneyOperation(reversed(f.request), { ...reversed(f.context),
      budget: reversed(f.context.budget), gas: reversed(f.context.gas), checkpoint: reversed(f.context.checkpoint) }, f.now);
    expect(candidate.digest).toBe(original.digest);
    expect(candidate.userOpHash).toBe(original.userOpHash);
    expect(candidate.plan.previewHash).toBe(original.plan.previewHash);
  });
  it.each(['recipient', 'amount', 'nonce', 'version', 'market', 'fee', 'release', 'checkpoint'] as const)('binds %s to the review', field => {
    const f = fixture(), original = prepareMoneyOperation(f.request, f.context, f.now);
    if (field === 'recipient') f.request = parseMoneyRequest({ ...f.request, recipient_address: address('4') });
    if (field === 'amount') f.request = parseMoneyRequest({ ...f.request, amount_atomic: '20000001' });
    if (field === 'nonce') f.context.nonce = 1n;
    if (field === 'version') f.context.security_version = 3n;
    if (field === 'release') f.request = parseMoneyRequest({ ...f.request, client_release_id: 'money-test-2' });
    if (field === 'checkpoint') f.context.checkpoint.block_hash = hash('f');
    if (field === 'fee') f.context.gas.maxFeePerGas = 1n;
    if (field === 'market') {
      const document = JSON.stringify({ ...JSON.parse(f.context.market.document), valid_until: 2001 });
      f.context.market = { document, digest: deploymentDocumentDigest(document) };
    }
    expect(prepareMoneyOperation(f.request, f.context, f.now).digest).not.toBe(original.digest);
  });
  it.each(['0', '01', '-1', '1.5', '1e6', ((1n << 256n) - 1n).toString()])('rejects non-exact amount %s', amount_atomic => {
    expect(() => parseMoneyRequest({ ...fixture().request, amount_atomic })).toThrow();
  });
  it('rejects calldata, unknown schemas, alternative assets and cross-account requests', () => {
    const f = fixture();
    for (const patch of [{ calls: [] }, { schema_version: 2 }, { network_id: 'eip155:42161' },
      { asset_id: 'eip155:421614/erc20:' + address('5') }, { recipient_address: address('1') }]) {
      expect(() => prepareMoneyOperation({ ...f.request, ...patch }, f.context, f.now)).toThrow();
    }
    expect(() => prepareMoneyOperation(f.request, { ...f.context, wallet_account_id: 'wac_33333333-3333-4333-8333-333333333333' }, f.now)).toThrow();
  });
  it.each(['position', 'liquidity', 'gas', 'debt'] as const)('rejects insufficient or forbidden %s', field => {
    const f = fixture();
    if (field === 'position') f.context.budget.position_available_atomic = '19999999';
    if (field === 'liquidity') f.context.budget.liquidity_atomic = '19999999';
    if (field === 'gas') f.context.budget.native_available_atomic = '999';
    if (field === 'debt') f.context.budget.debt_base_atomic = '1';
    expect(() => prepareMoneyOperation(f.request, f.context, f.now)).toThrow();
  });
  it('checks supply balance and reserve capacity separately', () => {
    const f = fixture('aave_supply');
    f.context.budget.usdc_available_atomic = '19999999';
    expect(() => prepareMoneyOperation(f.request, f.context, f.now)).toThrow('MONEY_SUPPLY_FUNDS_INSUFFICIENT');
    f.context.budget.usdc_available_atomic = '100000000'; f.context.budget.supply_capacity_atomic = '19999999';
    expect(() => prepareMoneyOperation(f.request, f.context, f.now)).toThrow('MONEY_SUPPLY_FUNDS_INSUFFICIENT');
  });
  it('checks expiry, market digest and exact gas bounds', () => {
    const f = fixture();
    expect(() => prepareMoneyOperation(f.request, f.context, 1020)).toThrow();
    expect(() => prepareMoneyOperation(f.request, { ...f.context, market: { ...f.context.market, digest: hash('f') } }, f.now)).toThrow();
    expect(() => prepareMoneyOperation(f.request, { ...f.context, gas: { ...f.context.gas, callGasLimit: 10000n } }, f.now)).toThrow();
  });
});

describe('passkey consent and durable money reviews', () => {
  function consentFixture() {
    const f = fixture(), keys = initializationFixture();
    const policy: SecurityPolicy = { mode: 'active', spendThreshold: 1, adminThreshold: 1, upgradeDelaySeconds: 259200,
      signers: [{ kind: 1, verifier: keys.profile.webauthn_verifier.address, verifierCodeHash: hash('a'), key: keys.input.publicKey, roles: 3 }] };
    f.context.policy_hash = hashSecurityPolicy(policy);
    return { ...f, keys, policy, candidate: prepareMoneyOperation(f.request, f.context, f.now) };
  }
  it('reconstructs a draft but never accepts it as historical signed consent', async () => {
    const f = consentFixture(), draft = writeMoneyDraft({ request: f.request, context: f.context, policy: f.policy,
      scope: f.keys.input.scope, prepared_at: f.now });
    expect(readMoneyDraft(draft.json, draft.digest).candidate.digest).toBe(f.candidate.digest);
    await expect(readMoneyReview(draft.json, draft.digest)).rejects.toThrow();
  });
  it('verifies a real P256 signature for the exact reconstructed operation', async () => {
    const f = consentFixture(), review = writeMoneyReview({ request: f.request, context: f.context, policy: f.policy,
      scope: f.keys.input.scope, prepared_at: f.now, approved_at: f.now + 1,
      proofs: [{ signerIndex: 0, kind: 'webauthn', assertion: f.keys.assertion(f.candidate.digest) }] });
    const result = await readMoneyReview(review.json, review.digest);
    expect(result.candidate.digest).toBe(f.candidate.digest);
    expect(result.operation.signature).not.toBe('0x');
    expect(result.operation.callData).toBe(f.candidate.operation.callData);
  });
  it('rejects signature substitution even if a storage checksum is recomputed', async () => {
    const f = consentFixture(), review = writeMoneyReview({ request: f.request, context: f.context, policy: f.policy,
      scope: f.keys.input.scope, prepared_at: f.now, approved_at: f.now + 1,
      proofs: [{ signerIndex: 0, kind: 'webauthn', assertion: f.keys.assertion(hash('f')) }] });
    await expect(readMoneyReview(review.json, review.digest)).rejects.toThrow();
  });
  it('rejects late approval and unknown fields in durable data', () => {
    const f = consentFixture(), draft = writeMoneyDraft({ request: f.request, context: f.context, policy: f.policy,
      scope: f.keys.input.scope, prepared_at: f.now });
    const document = JSON.parse(draft.json); document.unknown = true;
    const json = JSON.stringify(document);
    expect(() => readMoneyDraft(json, deploymentDocumentDigest(json))).toThrow();
    document.unknown = undefined; document.approved_at = f.context.valid_until;
    const expired = JSON.stringify(document);
    expect(() => readMoneyDraft(expired, deploymentDocumentDigest(expired))).toThrow();
  });
});
