import type { Hex } from 'viem';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import type { NetworkId } from '@gatopago/shared/v3/primitives';

/** Test configuration, not admission of a real network or a production SLA. */
export function finalityPolicyFixture(
  network: { network_id: NetworkId; genesis_hash: Hex },
  now: number,
) {
  return {
    schema_version: 1,
    policy_id: 'synthetic_finality',
    network_id: network.network_id,
    genesis_hash: network.genesis_hash,
    mechanism: 'op_stack_l1_data_finalized',
    valid_from: now - 60,
    valid_until: now + 86400,
    max_latest_age_seconds: 60,
    max_finalized_age_seconds: 3600,
    max_clock_skew_seconds: 5,
    evidence_ttl_seconds: 30,
  };
}
export function finalityPin(policy: ReturnType<typeof finalityPolicyFixture>) {
  const document = JSON.stringify(policy);
  return { document, digest: deploymentDocumentDigest(document) };
}
