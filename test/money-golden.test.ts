import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { prepareMoneyOperation, type MoneyOperationContext } from '../packages/shared/dist/v3/moneyOperation.js';
import { parseMoneyRequest } from '../packages/shared/dist/v3/moneyWire.js';
import { authorizationTypes } from '../packages/shared/dist/v3/authorizations.js';

const golden = JSON.parse(readFileSync(new URL('../contracts/test/fixtures/money-programs-golden.json', import.meta.url), 'utf8'));
describe('Fixed cross-language unsigned money vectors', () => {
  it.each(golden.vectors)('reconstructs $request.kind from fixed review fields', vector => {
    const raw = vector.context;
    const context: MoneyOperationContext = { ...raw, nonce: BigInt(raw.nonce), security_version: BigInt(raw.security_version),
      gas: Object.fromEntries(Object.entries(raw.gas).map(([key, value]) => [key, BigInt(value as string)])) };
    const candidate = prepareMoneyOperation(parseMoneyRequest(vector.request), context, vector.now);
    expect(candidate.operation.callData).toBe(vector.calldata);
    expect(encodeAbiParameters(parseAbiParameters('(address target,uint256 value,bytes data)[]'), [candidate.calls])).toBe(vector.calls_abi);
    expect(encodeAbiParameters([{ type: 'tuple', components: authorizationTypes.ExecutionPlan }], [candidate.plan])).toBe(vector.plan_abi);
    expect(candidate.calls_hash).toBe(vector.calls_hash); expect(candidate.userOpHash).toBe(vector.userop_hash); expect(candidate.digest).toBe(vector.consent_digest);
    expect(candidate.plan.assetLimitsHash).toBe(vector.asset_limits_hash); expect(candidate.plan.feePolicyHash).toBe(vector.fee_policy_hash);
    expect(candidate.plan.previewHash).toBe(vector.preview_hash);
  });
});
