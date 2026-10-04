import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { zeroAddress, zeroHash } from 'viem';
import { hashSecurityManifest } from '@gatopago/shared/v3/authorizations';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import { prepareInitialization } from '@gatopago/shared/v3/initialization';
import {
  prepareBackupEnrollment,
  type BackupSignerEnrollment,
  type BackupEnrollmentInput,
} from '@gatopago/shared/v3/backup-enrollment';
import { Role, signerId, type SecurityPolicy } from '@gatopago/shared/v3/security-policy';
import { initializationFixture } from './v3Initialization';
import { fixtureHash } from './v3DeploymentFixture';

/** Ephemeral local cryptographic factors. Labels/provider names are intentionally NOT independence evidence. */
export function backupFixture() {
  const f = initializationFixture(),
    initial = prepareInitialization(f.input);
  const keys = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  const nextPolicy: SecurityPolicy = {
    ...initial.policy,
    mode: 'active',
    adminThreshold: 1,
    signers: [
      initial.policy.signers[0],
      ...keys.map((key) => ({
        kind: 0 as const,
        verifier: zeroAddress,
        verifierCodeHash: zeroHash,
        key: key.address.toLowerCase() as `0x${string}`,
        roles: Role.SPEND | Role.ADMIN,
      })),
    ].sort((a, b) => signerId(a).localeCompare(signerId(b))),
  };
  const input: BackupEnrollmentInput = {
    initialization: f.input,
    nextPolicy,
    validAfter: f.input.validAfter,
    validUntil: f.input.validUntil,
    proposalValidUntil: f.input.validAfter + 86400,
    observation: {
      status: 'recognized',
      account: initial.account,
      account_id: initial.message.accountId,
      network_id: initial.profile.deployment.network_id,
      manifest_id: initial.profile.deployment.manifest_id,
      manifest_sha256: deploymentDocumentDigest(JSON.stringify(initial.profile.deployment)),
      checkpoint: { block_hash: fixtureHash('c'), block_number: '100' },
      spend_readiness: 'not_assessed',
      implementation: initial.profile.deployment.components.implementation.address,
      security_version: '1',
      storage_layout_hash: initial.profile.deployment.storage_layout_hash,
      security: {
        phase: 'active_policy',
        policy: initial.policy,
        policy_hash: initial.message.initialSecurityCommitment,
        manifest_hash: hashSecurityManifest({
          accountId: initial.message.accountId,
          generation: 3,
          securityVersion: 1n,
          previousManifestHash: zeroHash,
          policyHash: initial.message.initialSecurityCommitment,
          chainScopeHash: initial.message.chainScopeHash,
        }),
        chain_scope_hash: initial.message.chainScopeHash,
        upgrades_frozen: false,
        creation_valid_after: 0,
        creation_valid_until: 0,
        nonces: { spend: '0', admin: '0' },
        pending: null,
      },
    },
  };
  async function proofs(value = input): Promise<BackupSignerEnrollment[]> {
    const prepared = prepareBackupEnrollment(value, value.validAfter),
      result: BackupSignerEnrollment[] = [];
    for (const req of prepared.enrollments) {
      const member = prepared.nextPolicy.signers[req.signerIndex];
      if (member.kind === 1)
        result.push({
          signerIndex: req.signerIndex,
          kind: 'webauthn',
          assertion: f.assertion(req.digest),
        });
      else {
        const key = keys.find((candidate) => candidate.address.toLowerCase() === member.key);
        if (!key) throw new Error('Missing ephemeral enrollment factor');
        result.push({
          signerIndex: req.signerIndex,
          kind: 'ecdsa',
          signature: await key.sign({ hash: req.digest }),
        });
      }
    }
    return result;
  }
  function pending(value = input): BackupEnrollmentInput['observation'] {
    const p = prepareBackupEnrollment(value, value.validAfter),
      observation = structuredClone(value.observation);
    observation.checkpoint = {
      block_hash: fixtureHash('d'),
      block_number: (BigInt(observation.checkpoint.block_number) + 1n).toString(),
    };
    observation.security.nonces.admin = (p.message.nonce + 1n).toString();
    observation.security.pending = {
      kind: 1,
      hash: p.digest,
      security_version: '1',
      previous_manifest_hash: p.message.previousManifestHash,
      chain_scope_hash: p.message.chainScopeHash,
      ready_at: value.validAfter,
      valid_until: value.proposalValidUntil,
    };
    return observation;
  }
  return { ...f, input, initial, keys, proofs, pending };
}
