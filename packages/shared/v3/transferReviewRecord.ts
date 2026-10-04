import { parsePaymasterTerms } from './paymaster';
import { getAddress, type Hex } from 'viem';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { encodeExecutionSignature } from './execution';
import { parseAtomicAmount, parseResourceId } from './primitives';
import { hashSecurityPolicy } from './securityPolicy';
import { parseTransferRequest } from './transfer';
import { verifyTransferQuorum, type authorizeTransferOperation } from './transferAuthorization';
import { prepareTransferOperation } from './transferOperation';
import { assertWebAuthnScope } from './webauthn';
import { parseSecurityPolicyRecord as parseStoredPolicy } from './securityPolicyRecord';
import { readAssertionRecord, writeAssertionRecord } from './assertionRecord';

type Review = Awaited<ReturnType<typeof authorizeTransferOperation>>['consent_review'];
const maxLength = 150_000;
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TRANSFER_REVIEW_INVALID');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 2048) {
  if (typeof value !== 'string' || value.length > max) throw new Error('TRANSFER_REVIEW_INVALID');
  return value;
}
function integer(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('TRANSFER_REVIEW_INVALID');
  return value;
}
function hash(value: unknown) {
  requireHash(value);
  return value;
}

export function writeTransferReview(review: Review) {
  const c = review.context;
  const context = {
    account: getAddress(c.account),
    account_id: c.account_id,
    security_version: c.security_version.toString(),
    deployment_digest: c.deployment_digest,
    policy_hash: c.policy_hash,
    native_asset_id: c.native_asset_id,
    fee_recipient: c.fee_recipient === null ? null : getAddress(c.fee_recipient),
    entry_point: getAddress(c.entry_point),
    nonce: c.nonce.toString(),
    budget: {
      wallet_id: c.budget.wallet_id,
      asset_id: c.budget.asset_id,
      asset_available_atomic: c.budget.asset_available_atomic,
      native_available_atomic: c.budget.native_available_atomic,
      maximum_native_gas_atomic: c.budget.maximum_native_gas_atomic,
      platform_fee: {
        asset_id: c.budget.platform_fee.asset_id,
        amount_atomic: c.budget.platform_fee.amount_atomic,
      },
    },
    gas: {
      verificationGasLimit: c.gas.verificationGasLimit.toString(),
      callGasLimit: c.gas.callGasLimit.toString(),
      preVerificationGas: c.gas.preVerificationGas.toString(),
      maxFeePerGas: c.gas.maxFeePerGas.toString(),
      maxPriorityFeePerGas: c.gas.maxPriorityFeePerGas.toString(),
    },
    ...(c.sponsorship ? { sponsorship: parsePaymasterTerms(c.sponsorship) } : {}),
    checkpoint: {
      block_number: c.checkpoint.block_number,
      block_hash: c.checkpoint.block_hash,
      observed_at: c.checkpoint.observed_at,
      expires_at: c.checkpoint.expires_at,
    },
    valid_until: c.valid_until,
  };
  const proofs = review.proofs.map((p) =>
    p.kind === 'webauthn'
      ? { signerIndex: p.signerIndex, kind: p.kind, assertion: writeAssertionRecord(p.assertion) }
      : { signerIndex: p.signerIndex, kind: p.kind, signature: p.signature },
  );
  const json = JSON.stringify({
    schema_version: 1,
    request: parseTransferRequest(review.request),
    context,
    policy: parseStoredPolicy(review.policy),
    scope: { rpId: review.scope.rpId, origin: review.scope.origin },
    prepared_at: review.prepared_at,
    approved_at: review.approved_at,
    proofs,
  });
  if (json.length > maxLength) throw new Error('TRANSFER_REVIEW_INVALID');
  return Object.freeze({ json, digest: deploymentDocumentDigest(json) });
}

function decodeTransferReview(json: unknown, digest: unknown) {
  requireHash(digest);
  if (
    typeof json !== 'string' ||
    json.length > maxLength ||
    deploymentDocumentDigest(json) !== digest
  )
    throw new Error('TRANSFER_REVIEW_INVALID');
  const root = row(JSON.parse(json));
  if (root.schema_version !== 1) throw new Error('TRANSFER_REVIEW_INVALID');
  const c = row(root.context),
    b = row(c.budget),
    fee = row(b.platform_fee),
    g = row(c.gas),
    cp = row(c.checkpoint),
    scope = row(root.scope);
  const context: Review['context'] = {
    account: getAddress(string(c.account)),
    account_id: hash(c.account_id),
    security_version: BigInt(parseAtomicAmount(c.security_version)),
    deployment_digest: hash(c.deployment_digest),
    policy_hash: hash(c.policy_hash),
    native_asset_id: string(c.native_asset_id),
    fee_recipient: c.fee_recipient === null ? null : getAddress(string(c.fee_recipient)),
    entry_point: getAddress(string(c.entry_point)),
    nonce: BigInt(parseAtomicAmount(c.nonce)),
    budget: {
      wallet_id: parseResourceId('wallet', b.wallet_id),
      asset_id: string(b.asset_id),
      asset_available_atomic: parseAtomicAmount(b.asset_available_atomic),
      native_available_atomic: parseAtomicAmount(b.native_available_atomic),
      maximum_native_gas_atomic: parseAtomicAmount(b.maximum_native_gas_atomic),
      platform_fee: {
        asset_id: string(fee.asset_id),
        amount_atomic: parseAtomicAmount(fee.amount_atomic),
      },
    },
    gas: {
      verificationGasLimit: BigInt(parseAtomicAmount(g.verificationGasLimit)),
      callGasLimit: BigInt(parseAtomicAmount(g.callGasLimit)),
      preVerificationGas: BigInt(parseAtomicAmount(g.preVerificationGas)),
      maxFeePerGas: BigInt(parseAtomicAmount(g.maxFeePerGas)),
      maxPriorityFeePerGas: BigInt(parseAtomicAmount(g.maxPriorityFeePerGas)),
    },
    ...(Object.hasOwn(c, 'sponsorship') ? { sponsorship: parsePaymasterTerms(c.sponsorship) } : {}),
    checkpoint: {
      block_number: parseAtomicAmount(cp.block_number),
      block_hash: hash(cp.block_hash),
      observed_at: integer(cp.observed_at),
      expires_at: integer(cp.expires_at),
    },
    valid_until: integer(c.valid_until),
  };
  if (!Array.isArray(root.proofs) || root.proofs.length > 16)
    throw new Error('TRANSFER_REVIEW_INVALID');
  const proofs: Review['proofs'] = root.proofs.map((value: unknown) => {
    const p = row(value),
      signerIndex = integer(p.signerIndex);
    if (p.kind === 'webauthn')
      return { signerIndex, kind: 'webauthn', assertion: readAssertionRecord(p.assertion) };
    if (
      p.kind !== 'ecdsa' ||
      typeof p.signature !== 'string' ||
      !/^0x[0-9a-f]{130}$(?![\s\S])/.test(p.signature)
    )
      throw new Error('TRANSFER_REVIEW_INVALID');
    return { signerIndex, kind: 'ecdsa', signature: p.signature as Hex };
  });
  const review: Review = {
    request: parseTransferRequest(root.request),
    context,
    policy: parseStoredPolicy(root.policy),
    scope: { rpId: string(scope.rpId, 253), origin: string(scope.origin) },
    proofs,
    prepared_at: integer(root.prepared_at),
    approved_at: integer(root.approved_at),
  };
  assertWebAuthnScope(review.scope);
  if (
    writeTransferReview(review).json !== json ||
    review.approved_at < review.prepared_at ||
    review.approved_at >= context.valid_until
  ) {
    throw new Error('TRANSFER_REVIEW_INVALID');
  }
  const candidate = prepareTransferOperation(review.request, context, review.prepared_at);
  if (hashSecurityPolicy(review.policy) !== candidate.policy_hash)
    throw new Error('TRANSFER_REVIEW_INVALID');
  return { review, candidate };
}

export function writeTransferDraft(input: Omit<Review, 'approved_at' | 'proofs'>) {
  const record = writeTransferReview({ ...input, approved_at: input.prepared_at, proofs: [] });
  readTransferDraft(record.json, record.digest);
  return record;
}

export function readTransferDraft(json: unknown, digest: unknown) {
  const { review, candidate } = decodeTransferReview(json, digest);
  if (
    review.proofs.length !== 0 ||
    review.approved_at !== review.prepared_at ||
    review.policy.mode !== 'active'
  ) {
    throw new Error('TRANSFER_DRAFT_INVALID');
  }
  const { request, context, policy, scope, prepared_at } = review;
  return Object.freeze({ review: { request, context, policy, scope, prepared_at }, candidate });
}

export async function readTransferReview(json: unknown, digest: unknown) {
  const { review, candidate } = decodeTransferReview(json, digest);
  const { proofs } = review;
  const signatures = await verifyTransferQuorum(
    candidate.digest,
    review.policy,
    review.scope,
    proofs,
  );
  const operation = Object.freeze({
    ...candidate.operation,
    signature: encodeExecutionSignature(candidate.plan, signatures),
  });
  return Object.freeze({ review, candidate, operation });
}
