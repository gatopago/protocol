import { isAddressEqual, type Address } from 'viem';
import {
  assertAssetNetwork,
  parseAtomicAmount,
  type NetworkId,
  type ResourceId,
} from './primitives';
import { assertFinalityAssessment, type FinalityAssessment } from './finality';
import type { prepareTransferOperation } from './transferOperation';

export function assertTransferBalance(
  candidate: ReturnType<typeof prepareTransferOperation>,
  context: Parameters<typeof prepareTransferOperation>[1],
  evidence: {
    wallet_id: ResourceId<'wallet'>;
    network_id: NetworkId;
    address: Address;
    checkpoint: { block_hash: `0x${string}`; block_number: string; block_timestamp: string };
    observed_at: number;
    expires_at: number;
    finality_evidence: FinalityAssessment;
    balances: readonly { asset_id: string; amount_atomic: string }[];
    reserved: readonly { asset_id: string; amount_atomic: string }[];
  },
  securityFinality: FinalityAssessment,
  now: number,
) {
  if (
    evidence.wallet_id !== candidate.request.wallet_id ||
    evidence.network_id !== candidate.request.network_id ||
    !isAddressEqual(evidence.address, candidate.account) ||
    evidence.checkpoint.block_hash !== candidate.checkpoint.block_hash ||
    evidence.checkpoint.block_number !== candidate.checkpoint.block_number ||
    evidence.checkpoint.block_timestamp !== securityFinality.target.block_timestamp ||
    !Number.isSafeInteger(evidence.observed_at) ||
    evidence.observed_at < candidate.checkpoint.observed_at
  )
    throw new Error('TRANSFER_BALANCE_MISMATCH');
  assertFinalityAssessment(evidence.finality_evidence, {
    ...evidence.checkpoint,
    network_id: candidate.request.network_id,
    genesis_hash: securityFinality.genesis_hash,
  });
  const finality = evidence.finality_evidence;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(evidence.expires_at) ||
    now < evidence.observed_at ||
    now >= evidence.expires_at ||
    candidate.plan.validUntil > evidence.expires_at ||
    evidence.expires_at > finality.expires_at ||
    evidence.expires_at > evidence.observed_at + 60 ||
    finality.status !== 'finalized' ||
    finality.policy_sha256 !== securityFinality.policy_sha256 ||
    finality.mechanism !== securityFinality.mechanism ||
    finality.assessed_at > now
  )
    throw new Error('TRANSFER_BALANCE_EXPIRED');
  const relevant = new Set([candidate.request.asset_id, context.native_asset_id]);
  if (
    evidence.balances.length < relevant.size ||
    evidence.balances.length > 16 ||
    evidence.reserved.length !== relevant.size
  )
    throw new Error('TRANSFER_BALANCE_INCOMPLETE');
  const observed = new Map<string, bigint>(),
    reserved = new Map<string, bigint>();
  for (const asset of evidence.balances) {
    assertAssetNetwork(asset.asset_id, candidate.request.network_id);
    if (observed.has(asset.asset_id)) throw new Error('TRANSFER_BALANCE_DUPLICATE');
    observed.set(asset.asset_id, BigInt(parseAtomicAmount(asset.amount_atomic)));
  }
  for (const hold of evidence.reserved) {
    if (!relevant.has(hold.asset_id) || reserved.has(hold.asset_id))
      throw new Error('TRANSFER_RESERVATIONS_INVALID');
    reserved.set(hold.asset_id, BigInt(parseAtomicAmount(hold.amount_atomic)));
  }
  const available = (id: string) => {
    const balance = observed.get(id),
      hold = reserved.get(id);
    if (balance === undefined || hold === undefined || balance < hold)
      throw new Error('TRANSFER_BALANCE_INCOMPLETE');
    return (balance - hold).toString();
  };
  if (
    available(candidate.request.asset_id) !== context.budget.asset_available_atomic ||
    available(context.native_asset_id) !== context.budget.native_available_atomic
  )
    throw new Error('TRANSFER_BUDGET_MISMATCH');
}
