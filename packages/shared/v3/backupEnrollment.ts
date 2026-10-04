import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  recoverAddress,
  stringToHex,
  zeroHash,
  type Hex,
} from 'viem';
import {
  authorizationDigest,
  hashSecurityManifest,
  type AuthorizationMessages,
} from './authorizations';
import { MAX_CONSENT_WINDOW_SECONDS, MAX_PROPOSAL_COMPLETION_SECONDS } from './constants.mjs';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { prepareInitialization, type InitializationInput } from './initialization';
import { parseAtomicAmount } from './primitives';
import type { inspectAccountSecurity } from './securityInspection';
import {
  hashSecurityPolicy,
  Role,
  signerId,
  SignerKind,
  type SecurityPolicy,
} from './securityPolicy';
import {
  assertWebAuthnKey,
  encodeWebAuthnAssertion,
  type WebAuthnAssertionBytes,
} from './webauthn';

type SecurityObservation = Extract<
  Awaited<ReturnType<typeof inspectAccountSecurity>>,
  { status: 'recognized' }
>;
export interface BackupEnrollmentInput {
  readonly initialization: InitializationInput;

  readonly observation: SecurityObservation;
  readonly nextPolicy: SecurityPolicy;
  readonly validAfter: number;
  readonly validUntil: number;
  readonly proposalValidUntil: number;
}

export const accountBackupAbi = parseAbi([
  'struct SignerDescriptor { uint8 kind; address verifier; bytes32 verifierCodeHash; bytes key; uint8 roles; }',
  'struct SecurityPolicy { uint8 mode; SignerDescriptor[] signers; uint16 spendThreshold; uint16 adminThreshold; uint48 upgradeDelaySeconds; }',
  'struct SecurityChange { bytes32 accountId; uint32 generation; uint64 securityVersion; bytes32 previousManifestHash; bytes32 nextPolicyHash; bytes32 chainScopeHash; uint256 nonce; uint48 validAfter; uint48 validUntil; uint48 proposalValidUntil; }',
  'struct CommitProposal { bytes32 accountId; uint32 generation; uint64 securityVersion; bytes32 previousManifestHash; bytes32 proposalHash; bytes32 acknowledgementsHash; bytes32 chainScopeHash; uint256 nonce; uint48 validAfter; uint48 validUntil; }',
  'struct Signature { uint8 signerIndex; bytes signature; }',
  'function prepare(uint8 kind, SecurityChange message, SecurityPolicy next, uint256[] chains, Signature[] auth, Signature[] proofs) returns (bytes32)',
  'function commit(CommitProposal message, Signature[] auth)',
]);

export function assessPolicyContinuity(policy: SecurityPolicy) {
  hashSecurityPolicy(policy);
  const direct = policy.signers.filter((s) => s.kind === SignerKind.ECDSA);
  const reachable = (role: number, threshold: number) =>
    policy.mode === 'active' &&
    threshold > 0 &&
    direct.filter((s) => (s.roles & role) !== 0).length >= threshold;
  return Object.freeze({
    direct_key_quorums: Object.freeze({
      spend: reachable(Role.SPEND, policy.spendThreshold),
      admin: reachable(Role.ADMIN, policy.adminThreshold),
    }),
    factor_independence: 'not_assessed' as const,
    sovereign_readiness: 'not_assessed' as const,
  });
}

function window(after: number, until: number, now: number) {
  if (
    ![after, until, now].every(Number.isSafeInteger) ||
    after < 1 ||
    until >= 2 ** 48 ||
    until <= after ||
    until - after > MAX_CONSENT_WINDOW_SECONDS ||
    now < after ||
    now >= until
  )
    throw new Error('BACKUP_WINDOW_INVALID');
}

function state(
  initial: ReturnType<typeof prepareInitialization>,
  observation: SecurityObservation,
) {
  const manifestHash = hashSecurityManifest({
    accountId: initial.message.accountId,
    generation: 3,
    securityVersion: 1n,
    previousManifestHash: zeroHash,
    policyHash: initial.message.initialSecurityCommitment,
    chainScopeHash: initial.message.chainScopeHash,
  });
  if (
    observation.status !== 'recognized' ||
    observation.network_id !== initial.profile.deployment.network_id ||
    observation.account !== initial.account ||
    observation.account_id !== initial.message.accountId ||
    observation.manifest_sha256 !==
      deploymentDocumentDigest(JSON.stringify(initial.profile.deployment)) ||
    observation.security_version !== '1' ||
    observation.security.phase !== 'active_policy' ||
    observation.security.creation_valid_after !== 0 ||
    observation.security.creation_valid_until !== 0 ||
    observation.security.manifest_hash !== manifestHash ||
    observation.security.chain_scope_hash !== initial.message.chainScopeHash ||
    observation.security.policy_hash !== initial.message.initialSecurityCommitment ||
    hashSecurityPolicy(observation.security.policy) !== initial.message.initialSecurityCommitment
  ) {
    throw new Error('BACKUP_STATE_MISMATCH');
  }
  requireHash(observation.checkpoint.block_hash);
  parseAtomicAmount(observation.checkpoint.block_number);
  const nonce = BigInt(parseAtomicAmount(observation.security.nonces.admin));
  if (nonce >= 2n ** 256n - 1n) throw new Error('BACKUP_NONCE_EXHAUSTED');
  return nonce;
}

export function prepareBackupEnrollment(input: BackupEnrollmentInput, now: number) {
  window(input.validAfter, input.validUntil, now);
  if (
    !Number.isSafeInteger(input.proposalValidUntil) ||
    input.proposalValidUntil >= 2 ** 48 ||
    input.proposalValidUntil <= input.validUntil ||
    input.proposalValidUntil - input.validAfter > MAX_PROPOSAL_COMPLETION_SECONDS
  ) {
    throw new Error('BACKUP_PROPOSAL_WINDOW_INVALID');
  }
  const initial = prepareInitialization(input.initialization);
  const observation = structuredClone(input.observation);
  const nonce = state(initial, observation);
  if (observation.security.pending !== null) throw new Error('BACKUP_PROPOSAL_PENDING');

  if (nonce >= 2n ** 256n - 2n) throw new Error('BACKUP_NONCE_EXHAUSTED');
  const next: SecurityPolicy = Object.freeze({
    ...input.nextPolicy,
    signers: Object.freeze(input.nextPolicy.signers.map((s) => Object.freeze({ ...s }))),
  });
  if (
    next.spendThreshold !== 1 ||
    next.adminThreshold !== 1 ||
    next.signers.some((s) => s.roles !== (Role.SPEND | Role.ADMIN))
  )
    throw new Error('CONSUMER_POLICY_REQUIRED');
  const nextHash = hashSecurityPolicy(next),
    old = initial.policy.signers[0],
    oldId = signerId(old);
  if (
    next.mode !== 'active' ||
    !next.signers.some((s) => signerId(s) === oldId && (s.roles & Role.SPEND) !== 0)
  ) {
    throw new Error('BACKUP_MUST_RETAIN_INITIAL_FACTOR');
  }

  for (const member of next.signers) {
    if (member.kind === SignerKind.ERC1271) throw new Error('BACKUP_SIGNER_TRANSPORT_UNSUPPORTED');
    if (member.kind === SignerKind.WEBAUTHN) {
      if (member.verifier !== old.verifier || member.verifierCodeHash !== old.verifierCodeHash)
        throw new Error('BACKUP_VERIFIER_MISMATCH');
      assertWebAuthnKey(initial.scope, member.key);
    }
  }
  const message = Object.freeze({
    accountId: initial.message.accountId,
    generation: 3,
    securityVersion: 1n,
    previousManifestHash: observation.security.manifest_hash,
    nextPolicyHash: nextHash,
    chainScopeHash: initial.message.chainScopeHash,
    nonce,
    validAfter: input.validAfter,
    validUntil: input.validUntil,
    proposalValidUntil: input.proposalValidUntil,
  });
  const digest = authorizationDigest('SecurityChange', initial.chainId, initial.account, message);
  const enrollments = next.signers.flatMap((member, index) => {
    if (signerId(member) === oldId && member.roles === old.roles) return [];
    const proof = Object.freeze({
      accountId: message.accountId,
      generation: 3,
      securityVersion: 1n,
      signerId: signerId(member),
      nextPolicyHash: nextHash,
      contextHash: digest,
      nonce,
      validAfter: message.validAfter,
      validUntil: message.validUntil,
    });
    return [
      Object.freeze({
        signerIndex: index,
        message: proof,
        digest: authorizationDigest('EnrollmentProof', initial.chainId, initial.account, proof),
      }),
    ];
  });
  const expectedManifestHash = hashSecurityManifest({
    accountId: message.accountId,
    generation: 3,
    securityVersion: 2n,
    previousManifestHash: message.previousManifestHash,
    policyHash: nextHash,
    chainScopeHash: message.chainScopeHash,
  });
  return Object.freeze({
    initial,
    nextPolicy: next,
    message,
    digest,
    enrollments: Object.freeze(enrollments),
    expectedManifestHash,
    continuity: assessPolicyContinuity(next),
  });
}

export type BackupSignerEnrollment = { readonly signerIndex: number } & (
  | { readonly kind: 'ecdsa'; readonly signature: Hex }
  | { readonly kind: 'webauthn'; readonly assertion: WebAuthnAssertionBytes }
);

async function ecdsa(signature: Hex, digest: Hex, expected: Hex) {
  if (
    typeof signature !== 'string' ||
    signature.length !== 132 ||
    !/^0x[0-9a-f]{128}(1b|1c)$/.test(signature)
  )
    throw new Error('BACKUP_ECDSA_INVALID');
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (
    s === 0n ||
    s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
    (await recoverAddress({ hash: digest, signature })).toLowerCase() !== expected
  )
    throw new Error('BACKUP_ECDSA_INVALID');
  return signature;
}

export async function verifyBackupEcdsaEnrollment(
  input: BackupEnrollmentInput,
  signerIndex: number,
  signature: Hex,
  now: number,
) {
  const prepared = prepareBackupEnrollment(input, now);
  if (!Number.isInteger(signerIndex)) throw new Error('BACKUP_ENROLLMENTS_MISMATCH');
  const request = prepared.enrollments.find((item) => item.signerIndex === signerIndex);
  const member = prepared.nextPolicy.signers[signerIndex];
  if (!request || member?.kind !== SignerKind.ECDSA)
    throw new Error('BACKUP_ENROLLMENT_KIND_MISMATCH');
  const verified = await ecdsa(signature, request.digest, member.key);
  return Object.freeze({ kind: 'ecdsa' as const, signerIndex, signature: verified });
}

export async function authorizeBackupEnrollment(
  input: BackupEnrollmentInput,
  owner: WebAuthnAssertionBytes,
  proofs: readonly BackupSignerEnrollment[],
  now: number,
) {
  const prepared = prepareBackupEnrollment(input, now),
    submitted = structuredClone(proofs);
  const initial = prepared.initial;
  const auth = [
    {
      signerIndex: 0,
      signature: encodeWebAuthnAssertion({
        scope: initial.scope,
        key: initial.policy.signers[0].key,
        challenge: prepared.digest,
        response: owner,
      }),
    },
  ];
  if (
    submitted.length !== prepared.enrollments.length ||
    new Set(submitted.map((p) => p.signerIndex)).size !== submitted.length
  ) {
    throw new Error('BACKUP_ENROLLMENTS_MISMATCH');
  }
  const enrollments: { signerIndex: number; signature: Hex }[] = [];
  for (const request of prepared.enrollments) {
    const proof = submitted.find((p) => p.signerIndex === request.signerIndex),
      member = prepared.nextPolicy.signers[request.signerIndex];
    if (!proof) throw new Error('BACKUP_ENROLLMENTS_MISMATCH');
    let signature: Hex;
    if (member.kind === SignerKind.ECDSA && proof.kind === 'ecdsa')
      signature = await ecdsa(proof.signature, request.digest, member.key);
    else if (member.kind === SignerKind.WEBAUTHN && proof.kind === 'webauthn')
      signature = encodeWebAuthnAssertion({
        scope: initial.scope,
        key: member.key,
        challenge: request.digest,
        response: proof.assertion,
      });
    else throw new Error('BACKUP_ENROLLMENT_KIND_MISMATCH');
    enrollments.push({ signerIndex: request.signerIndex, signature });
  }
  const data = encodeFunctionData({
    abi: accountBackupAbi,
    functionName: 'prepare',
    args: [
      0,
      prepared.message,
      { ...prepared.nextPolicy, mode: 1 },
      initial.chains,
      auth,
      enrollments,
    ],
  });
  return Object.freeze({
    account: initial.account,
    value: 0n,
    data,
    proposalHash: prepared.digest,
    expectedManifestHash: prepared.expectedManifestHash,
    account_readiness: 'not_assessed' as const,
  });
}

export function prepareBackupCommit(
  input: BackupEnrollmentInput,
  observation: SecurityObservation,
  validAfter: number,
  validUntil: number,
  now: number,
) {
  window(validAfter, validUntil, now);

  const prepared = prepareBackupEnrollment(input, input.validAfter),
    nonce = state(prepared.initial, observation),
    pending = observation.security.pending;
  if (
    !pending ||
    pending.kind !== 1 ||
    pending.hash !== prepared.digest ||
    pending.security_version !== '1' ||
    pending.previous_manifest_hash !== prepared.message.previousManifestHash ||
    pending.chain_scope_hash !== prepared.message.chainScopeHash ||
    pending.valid_until !== prepared.message.proposalValidUntil ||
    pending.ready_at < prepared.message.validAfter ||
    pending.ready_at >= prepared.message.validUntil ||
    pending.ready_at > now ||
    validUntil > pending.valid_until ||
    nonce !== prepared.message.nonce + 1n ||
    BigInt(observation.checkpoint.block_number) <= BigInt(input.observation.checkpoint.block_number)
  ) {
    throw new Error('BACKUP_PENDING_MISMATCH');
  }

  const acknowledgementsHash = backupAcknowledgement(prepared.digest, observation.checkpoint);
  const message: AuthorizationMessages['CommitProposal'] = Object.freeze({
    accountId: prepared.message.accountId,
    generation: 3,
    securityVersion: 1n,
    previousManifestHash: prepared.message.previousManifestHash,
    proposalHash: prepared.digest,
    acknowledgementsHash,
    chainScopeHash: prepared.message.chainScopeHash,
    nonce,
    validAfter,
    validUntil,
  });
  return Object.freeze({
    prepared,
    message,
    digest: authorizationDigest(
      'CommitProposal',
      prepared.initial.chainId,
      prepared.initial.account,
      message,
    ),
  });
}

export function authorizeBackupCommit(
  input: BackupEnrollmentInput,
  observation: SecurityObservation,
  validAfter: number,
  validUntil: number,
  assertion: WebAuthnAssertionBytes,
  now: number,
) {
  const commit = prepareBackupCommit(input, observation, validAfter, validUntil, now),
    initial = commit.prepared.initial;
  const signature = encodeWebAuthnAssertion({
    scope: initial.scope,
    key: initial.policy.signers[0].key,
    challenge: commit.digest,
    response: assertion,
  });
  return Object.freeze({
    account: initial.account,
    value: 0n,
    data: encodeFunctionData({
      abi: accountBackupAbi,
      functionName: 'commit',
      args: [commit.message, [{ signerIndex: 0, signature }]],
    }),
    proposalHash: commit.prepared.digest,
    expectedManifestHash: commit.prepared.expectedManifestHash,
    account_readiness: 'not_assessed' as const,
  });
}

function backupAcknowledgement(proposal: Hex, checkpoint: SecurityObservation['checkpoint']) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
      [
        keccak256(
          stringToHex(
            'BootstrapAcknowledgementV1(bytes32 proposalHash,uint256 blockNumber,bytes32 blockHash)',
          ),
        ),
        proposal,
        BigInt(checkpoint.block_number),
        checkpoint.block_hash,
      ],
    ),
  );
}
