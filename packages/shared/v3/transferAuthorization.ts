import { isAddressEqual, recoverAddress, size, type Address, type Hex } from 'viem';
import { toPackedUserOperation } from 'viem/account-abstraction';
import { encodeExecutionSignature, type ExecutionSignature } from './execution';
import { hashSecurityPolicy, Role, SignerKind, type SecurityPolicy } from './securityPolicy';
import { prepareTransferOperation } from './transferOperation';
import { assertTransferSecurity } from './transferSecurity';
import { assertTransferBalance } from './transferBalance';
import {
  encodeWebAuthnAssertion,
  type WebAuthnAssertionBytes,
  type WebAuthnScope,
} from './webauthn';

type Proof = { signerIndex: number } & (
  { kind: 'ecdsa'; signature: Hex } | { kind: 'webauthn'; assertion: WebAuthnAssertionBytes }
);

export async function authorizeTransferOperation(
  request: Parameters<typeof prepareTransferOperation>[0],
  context: Parameters<typeof prepareTransferOperation>[1],
  approval: {
    prepared_at: number;
    reviewed_digest: Hex;
    policy: SecurityPolicy;
    scope: WebAuthnScope;
    security_evidence: Parameters<typeof assertTransferSecurity>[1];
    balance_evidence: Parameters<typeof assertTransferBalance>[2];
    nonce_evidence: {
      network_id: string;
      account: Address;
      entry_point: Address;
      checkpoint: { block_number: string; block_hash: Hex };
      nonce: string;
      observed_at: number;
    };
  },
  proofs: readonly Proof[],
  clock: () => number = () => Math.floor(Date.now() / 1000),
) {
  const snapshot = structuredClone({ request, context, approval, proofs });
  const candidate = prepareTransferOperation(
    snapshot.request,
    snapshot.context,
    snapshot.approval.prepared_at,
  );
  const checkTime = () => {
    const now = clock();
    if (
      !Number.isSafeInteger(now) ||
      now < candidate.plan.validAfter ||
      now >= candidate.plan.validUntil ||
      now >= candidate.checkpoint.expires_at
    )
      throw new Error('TRANSFER_CONSENT_EXPIRED');
    assertTransferSecurity(candidate, snapshot.approval.security_evidence, now);
    assertTransferBalance(
      candidate,
      snapshot.context,
      snapshot.approval.balance_evidence,
      snapshot.approval.security_evidence.finality,
      now,
    );
    const nonce = snapshot.approval.nonce_evidence;
    if (
      nonce.network_id !== candidate.request.network_id ||
      !isAddressEqual(nonce.account, candidate.account) ||
      !isAddressEqual(nonce.entry_point, candidate.plan.entryPoint) ||
      nonce.nonce !== candidate.plan.nonce.toString() ||
      nonce.checkpoint.block_hash !== candidate.checkpoint.block_hash ||
      nonce.checkpoint.block_number !== candidate.checkpoint.block_number ||
      !Number.isSafeInteger(nonce.observed_at) ||
      nonce.observed_at > now ||
      nonce.observed_at < now - 60
    )
      throw new Error('TRANSFER_NONCE_MISMATCH');
    return now;
  };
  checkTime();
  const policy = snapshot.approval.policy;
  if (
    candidate.digest !== snapshot.approval.reviewed_digest ||
    hashSecurityPolicy(policy) !== snapshot.context.policy_hash ||
    policy.mode !== 'active'
  )
    throw new Error('TRANSFER_REVIEW_MISMATCH');
  const signatures = await verifyTransferQuorum(
    candidate.digest,
    policy,
    snapshot.approval.scope,
    snapshot.proofs,
  );
  const approvedAt = checkTime();
  const signature = encodeExecutionSignature(candidate.plan, signatures);
  if (size(signature) > 70_000) throw new Error('TRANSFER_SIGNATURE_TOO_LARGE');
  const operation = Object.freeze({ ...candidate.operation, signature });

  const fundingReservation = [
    ...new Set([candidate.request.asset_id, snapshot.context.native_asset_id]),
  ]
    .sort()
    .map((asset_id) => {
      const observed = snapshot.approval.balance_evidence.balances.find(
        (row) => row.asset_id === asset_id,
      )!;
      const reserved = snapshot.approval.balance_evidence.reserved.find(
        (row) => row.asset_id === asset_id,
      )!;
      return Object.freeze({
        asset_id,
        observed_atomic: observed.amount_atomic,
        reserved_atomic: reserved.amount_atomic,
        debit_atomic:
          asset_id === candidate.request.asset_id
            ? candidate.funding.asset_debit_atomic
            : (
                BigInt(snapshot.context.budget.native_available_atomic) -
                BigInt(candidate.funding.native_remaining_atomic)
              ).toString(),
      });
    });
  return Object.freeze({
    ...candidate,
    operation,
    packed: Object.freeze(toPackedUserOperation(operation)),
    funding_reservation: Object.freeze(fundingReservation),
    consent_review: Object.freeze({
      request: snapshot.request,
      context: snapshot.context,
      policy,
      scope: snapshot.approval.scope,
      proofs: snapshot.proofs,
      prepared_at: snapshot.approval.prepared_at,
      approved_at: approvedAt,
    }),
  });
}

export async function verifyTransferQuorum(
  digest: Hex,
  inputPolicy: SecurityPolicy,
  scope: WebAuthnScope,
  proofs: readonly Proof[],
) {
  const snapshot = structuredClone({ digest, policy: inputPolicy, scope, proofs });
  const policy = snapshot.policy;
  hashSecurityPolicy(policy);
  if (policy.mode !== 'active') throw new Error('TRANSFER_REVIEW_MISMATCH');
  if (
    snapshot.proofs.length < policy.spendThreshold ||
    snapshot.proofs.length > policy.signers.length
  )
    throw new Error('TRANSFER_QUORUM_INVALID');
  const seen = new Set<number>();
  const signatures: ExecutionSignature[] = [];
  for (const proof of snapshot.proofs) {
    const member = policy.signers[proof.signerIndex];
    if (
      !Number.isInteger(proof.signerIndex) ||
      proof.signerIndex < 0 ||
      !member ||
      seen.has(proof.signerIndex) ||
      (member.roles & Role.SPEND) === 0
    )
      throw new Error('TRANSFER_QUORUM_INVALID');
    seen.add(proof.signerIndex);
    signatures.push(await verifyTransferProof(snapshot.digest, policy, snapshot.scope, proof));
  }
  signatures.sort((a, b) => a.signerIndex - b.signerIndex);
  return signatures;
}

export async function verifyTransferProof(
  digest: Hex,
  inputPolicy: SecurityPolicy,
  scope: WebAuthnScope,
  input: Proof,
): Promise<ExecutionSignature> {
  const snapshot = structuredClone({ digest, policy: inputPolicy, scope }),
    proof = structuredClone(input);
  hashSecurityPolicy(snapshot.policy);
  const member = snapshot.policy.signers[proof.signerIndex];
  if (
    snapshot.policy.mode !== 'active' ||
    !Number.isInteger(proof.signerIndex) ||
    proof.signerIndex < 0 ||
    !member ||
    (member.roles & Role.SPEND) === 0
  )
    throw new Error('TRANSFER_QUORUM_INVALID');
  let signature: Hex;
  if (member.kind === SignerKind.WEBAUTHN && proof.kind === 'webauthn') {
    signature = encodeWebAuthnAssertion({
      scope: snapshot.scope,
      key: member.key,
      challenge: snapshot.digest,
      response: proof.assertion,
    });
  } else if (member.kind === SignerKind.ECDSA && proof.kind === 'ecdsa') {
    signature = proof.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$(?![\s\S])/.test(signature))
      throw new Error('TRANSFER_SIGNATURE_INVALID');
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    if (
      s === 0n ||
      s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
      (await recoverAddress({ hash: snapshot.digest, signature })).toLowerCase() !== member.key
    )
      throw new Error('TRANSFER_SIGNATURE_INVALID');
  } else throw new Error('TRANSFER_SIGNER_TRANSPORT_UNSUPPORTED');
  return { signerIndex: proof.signerIndex, signature };
}
