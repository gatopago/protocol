import { isAddressEqual } from 'viem';
import type { inspectAccountSecurity } from './securityInspection';
import {
  assertFinalityAssessment,
  loadPinnedFinalityPolicy,
  type FinalityAssessment,
  type FinalityPolicyPin,
} from './finality';
import { loadPinnedDeploymentManifest } from './deployment';
import { hashSecurityPolicy } from './securityPolicy';
import type { prepareTransferOperation } from './transferOperation';
import { parseAtomicAmount } from './primitives';

type SecurityObservation = Awaited<ReturnType<typeof inspectAccountSecurity>>;

export interface TransferSecurityEvidence {
  document: string;
  digest: Parameters<typeof loadPinnedDeploymentManifest>[1];
  observation: SecurityObservation;
  finality: FinalityAssessment;
  finality_policy: FinalityPolicyPin;
  observed_at: number;
  expires_at: number;
}
export function assertTransferSecurity(
  candidate: ReturnType<typeof prepareTransferOperation>,
  evidence: TransferSecurityEvidence,
  now: number,
) {
  return checkSecurity(candidate, evidence, now, candidate.checkpoint);
}

export function assertCurrentTransferSecurity(
  candidate: ReturnType<typeof prepareTransferOperation>,
  evidence: TransferSecurityEvidence,
  now: number,
) {
  const checkpoint = evidence.observation.checkpoint;
  if (
    BigInt(parseAtomicAmount(checkpoint.block_number)) <
      BigInt(candidate.checkpoint.block_number) ||
    (checkpoint.block_number === candidate.checkpoint.block_number &&
      checkpoint.block_hash !== candidate.checkpoint.block_hash)
  ) {
    throw new Error('TRANSFER_SECURITY_CHECKPOINT');
  }
  return checkSecurity(candidate, evidence, now, checkpoint);
}
function checkSecurity(
  candidate: ReturnType<typeof prepareTransferOperation>,
  evidence: TransferSecurityEvidence,
  now: number,
  checkpoint: { block_number: string; block_hash: `0x${string}` },
) {
  const manifest = loadPinnedDeploymentManifest(evidence.document, evidence.digest);
  const observation = evidence.observation;
  if (
    evidence.digest !== candidate.deployment_digest ||
    manifest.lifecycle_status !== 'deployed' ||
    manifest.network_id !== candidate.request.network_id ||
    observation.status !== 'recognized' ||
    !('security' in observation) ||
    observation.manifest_sha256 !== evidence.digest ||
    observation.network_id !== manifest.network_id ||
    observation.account_id !== candidate.plan.accountId ||
    !isAddressEqual(observation.account, candidate.account) ||
    !isAddressEqual(observation.implementation, manifest.components.implementation.address) ||
    observation.storage_layout_hash !== manifest.storage_layout_hash ||
    observation.security_version !== candidate.plan.securityVersion.toString() ||
    observation.security.phase !== 'active_policy' ||
    observation.security.policy.mode !== 'active' ||
    observation.security.creation_valid_after !== 0 ||
    observation.security.creation_valid_until !== 0 ||
    hashSecurityPolicy(observation.security.policy) !== observation.security.policy_hash ||
    observation.security.policy_hash !== candidate.policy_hash ||
    observation.checkpoint.block_hash !== checkpoint.block_hash ||
    observation.checkpoint.block_number !== checkpoint.block_number ||
    !isAddressEqual(manifest.entry_point, candidate.plan.entryPoint)
  )
    throw new Error('TRANSFER_SECURITY_MISMATCH');
  const pin = loadPinnedFinalityPolicy(evidence.finality_policy, manifest);
  assertFinalityAssessment(evidence.finality, {
    ...evidence.finality.target,
    network_id: manifest.network_id,
    genesis_hash: manifest.genesis_hash,
    block_hash: checkpoint.block_hash,
    block_number: checkpoint.block_number,
  });
  const finality = evidence.finality;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(evidence.observed_at) ||
    !Number.isSafeInteger(evidence.expires_at) ||
    evidence.observed_at > now ||
    evidence.observed_at < finality.assessed_at ||
    now < candidate.plan.validAfter ||
    now >= candidate.plan.validUntil ||
    now >= evidence.expires_at ||
    evidence.expires_at > finality.expires_at ||
    candidate.plan.validUntil > evidence.expires_at ||
    evidence.expires_at > evidence.observed_at + 60 ||
    finality.status !== 'finalized' ||
    finality.policy_sha256 !== evidence.finality_policy.digest ||
    finality.mechanism !== pin.mechanism ||
    now < pin.valid_from ||
    now >= pin.valid_until ||
    finality.assessed_at < pin.valid_from ||
    finality.assessed_at > now ||
    finality.expires_at >
      Math.min(pin.valid_until, finality.assessed_at + pin.evidence_ttl_seconds) ||
    BigInt(finality.target.block_timestamp) > BigInt(now + pin.max_clock_skew_seconds) ||
    BigInt(now) - BigInt(finality.target.block_timestamp) > BigInt(pin.max_finalized_age_seconds)
  )
    throw new Error('TRANSFER_SECURITY_EXPIRED');
  return observation.security.policy;
}
