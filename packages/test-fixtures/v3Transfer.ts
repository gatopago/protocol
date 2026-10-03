import type { Address } from 'viem';
import { backupFixture } from './v3Backup';
import { createResourceId } from '@gatopago/shared/v3/primitives';
import { hashSecurityPolicy, type SecurityPolicy } from '@gatopago/shared/v3/security-policy';
import { parseTransferRequest } from '@gatopago/shared/v3/transfer';
import { prepareTransferOperation } from '@gatopago/shared/v3/transfer-operation';
import { finalityPin, finalityPolicyFixture } from './v3Finality';
import type { FinalityAssessment } from '@gatopago/shared/v3/finality';

export function transferFixture(native = true) {
  const f = backupFixture(); const now = f.input.validAfter;
  const policy: SecurityPolicy = { ...f.input.nextPolicy, spendThreshold: 2 };
  const request = parseTransferRequest({ schema_version: 1, generation: 3, wallet_id: createResourceId('wallet'),
    network_id: f.initial.profile.deployment.network_id, asset_id: `${f.initial.profile.deployment.network_id}/${native ? 'slip44:60' : `erc20:0x${'ab'.repeat(20)}`}`,
    destination: { address: `0x${'cd'.repeat(20)}`, address_type: 'evm_unknown' },
    amount: { kind: 'exact', amount_atomic: '10' }, client_release_id: 'v3-test' });
  const context = { account: f.initial.account, account_id: f.initial.message.accountId, security_version: 2n,
    deployment_digest: f.input.observation.manifest_sha256, policy_hash: hashSecurityPolicy(policy), native_asset_id: `${request.network_id}/slip44:60`,
    fee_recipient: null as Address | null, entry_point: f.initial.message.entryPoint, nonce: 0n,
    budget: { wallet_id: request.wallet_id, asset_id: request.asset_id, asset_available_atomic: '10000', native_available_atomic: '10000',
      maximum_native_gas_atomic: '1000', platform_fee: { asset_id: request.asset_id, amount_atomic: '0' } },
    gas: { verificationGasLimit: 100n, callGasLimit: 100n, preVerificationGas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
    checkpoint: { block_number: '123', block_hash: f.input.observation.checkpoint.block_hash, observed_at: now, expires_at: now + 30 }, valid_until: now + 20 };
  const p = prepareTransferOperation(request, context, now);
  const manifest = f.initial.profile.deployment;
  const pin = finalityPin(finalityPolicyFixture(manifest, now));
  const target = { block_number: '123', block_hash: context.checkpoint.block_hash, block_timestamp: String(now - 10) };
  const finality: FinalityAssessment = { schema_version: 1, status: 'finalized', policy_sha256: pin.digest,
    mechanism: 'op_stack_l1_data_finalized', network_id: manifest.network_id, genesis_hash: manifest.genesis_hash,
    target, checkpoint: target, assessed_at: now, expires_at: now + 30 };
  const approval = { prepared_at: now, reviewed_digest: p.digest, policy, scope: f.initial.scope,
    nonce_evidence: { network_id: request.network_id, account: context.account, entry_point: context.entry_point,
      checkpoint: target, nonce: context.nonce.toString(), observed_at: now },
    balance_evidence: { wallet_id: request.wallet_id, network_id: request.network_id, address: context.account, checkpoint: target,
      observed_at: now, expires_at: now + 30, finality_evidence: finality,
      balances: [...new Set([request.asset_id, context.native_asset_id])].map(asset_id => ({ asset_id, amount_atomic: '10000' })),
      reserved: [...new Set([request.asset_id, context.native_asset_id])].map(asset_id => ({ asset_id, amount_atomic: '0' })) },
    security_evidence: { document: JSON.stringify(manifest), digest: context.deployment_digest, observed_at: now, expires_at: now + 30,
      finality, finality_policy: pin, observation: { ...f.input.observation, security_version: '2', checkpoint: target,
        security: { ...f.input.observation.security, phase: 'active_policy', policy, policy_hash: context.policy_hash } } } };
  async function proofs(digest = p.digest) {
    const wi = policy.signers.findIndex(s => s.kind === 1), ei = policy.signers.findIndex(s => s.kind === 0);
    const key = f.keys.find(k => k.address.toLowerCase() === policy.signers[ei].key)!;
    return [{ signerIndex: wi, kind: 'webauthn' as const, assertion: f.assertion(digest) },
      { signerIndex: ei, kind: 'ecdsa' as const, signature: await key.sign({ hash: digest }) }];
  }
  return { f, now, request, context, p, approval, proofs };
}
