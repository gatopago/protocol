import { getAddress, size, type Hex } from 'viem';
import { deploymentDocumentDigest, requireHash } from './deployment';
import { encodeExecutionSignature } from './execution';
import { parseAtomicAmount, parseResourceId } from './primitives';
import { prepareMoneyOperation, type MoneyOperationContext } from './moneyOperation';
import { hashSecurityPolicy, SignerKind, type SecurityPolicy } from './securityPolicy';
import { parseSecurityPolicyRecord } from './securityPolicyRecord';
import { verifyTransferQuorum } from './transferAuthorization';
import { readAssertionRecord, writeAssertionRecord } from './assertionRecord';
import { assertWebAuthnScope, type WebAuthnScope } from './webauthn';
import {
  moneyAddress,
  moneyFields,
  moneyInteger,
  parseMoneyRequest,
  type MoneyOperationRequest,
} from './moneyWire';

export type MoneyProof = Parameters<typeof verifyTransferQuorum>[3][number];
export interface MoneyConsentReview {
  request: MoneyOperationRequest;
  context: MoneyOperationContext;
  policy: SecurityPolicy;
  scope: WebAuthnScope;
  prepared_at: number;
  approved_at: number;
  proofs: readonly MoneyProof[];
}
function hash(value: unknown): Hex {
  requireHash(value);
  return value;
}
function text(value: unknown, max = 20_000): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new Error('MONEY_REVIEW_INVALID');
  return value;
}
function consumerPolicy(input: unknown): SecurityPolicy {
  const policy = parseSecurityPolicyRecord(input);
  if (
    policy.signers.some((signer) => signer.kind !== SignerKind.WEBAUTHN) ||
    policy.spendThreshold < 1 ||
    policy.adminThreshold < 1
  )
    throw new Error('MONEY_CONSUMER_POLICY_REQUIRED');
  return policy;
}
function encodeContext(c: MoneyOperationContext) {
  return {
    account: getAddress(c.account),
    wallet_account_id: c.wallet_account_id,
    account_id: c.account_id,
    deployment_digest: c.deployment_digest,
    policy_hash: c.policy_hash,
    security_version: c.security_version.toString(),
    entry_point: getAddress(c.entry_point),
    nonce: c.nonce.toString(),
    market: { document: c.market.document, digest: c.market.digest },
    native_asset_id: c.native_asset_id,
    gas: {
      verificationGasLimit: c.gas.verificationGasLimit.toString(),
      callGasLimit: c.gas.callGasLimit.toString(),
      preVerificationGas: c.gas.preVerificationGas.toString(),
      maxFeePerGas: c.gas.maxFeePerGas.toString(),
      maxPriorityFeePerGas: c.gas.maxPriorityFeePerGas.toString(),
    },
    budget: {
      usdc_available_atomic: c.budget.usdc_available_atomic,
      position_available_atomic: c.budget.position_available_atomic,
      native_available_atomic: c.budget.native_available_atomic,
      maximum_native_gas_atomic: c.budget.maximum_native_gas_atomic,
      debt_base_atomic: c.budget.debt_base_atomic,
      liquidity_atomic: c.budget.liquidity_atomic,
      supply_capacity_atomic: c.budget.supply_capacity_atomic,
    },
    checkpoint: {
      block_number: c.checkpoint.block_number,
      block_hash: c.checkpoint.block_hash,
      observed_at: c.checkpoint.observed_at,
      expires_at: c.checkpoint.expires_at,
    },
    valid_until: c.valid_until,
  };
}
export function writeMoneyReview(input: MoneyConsentReview) {
  const review = structuredClone(input),
    request = parseMoneyRequest(review.request),
    policy = consumerPolicy(review.policy);
  assertWebAuthnScope(review.scope);
  const context = encodeContext(review.context);
  const proofs = review.proofs.map((proof) =>
    proof.kind === 'webauthn'
      ? {
          signerIndex: proof.signerIndex,
          kind: proof.kind,
          assertion: writeAssertionRecord(proof.assertion),
        }
      : { signerIndex: proof.signerIndex, kind: proof.kind, signature: proof.signature },
  );
  const json = JSON.stringify({
    schema_version: 1,
    request,
    context,
    policy,
    scope: { rpId: review.scope.rpId, origin: review.scope.origin },
    prepared_at: review.prepared_at,
    approved_at: review.approved_at,
    proofs,
  });
  if (json.length > 150_000) throw new Error('MONEY_REVIEW_TOO_LARGE');
  return Object.freeze({ json, digest: deploymentDocumentDigest(json) });
}
function decodeReview(json: unknown, digest: unknown) {
  if (
    typeof json !== 'string' ||
    json.length > 150_000 ||
    deploymentDocumentDigest(json) !== hash(digest)
  )
    throw new Error('MONEY_REVIEW_INVALID');
  const root = moneyFields(JSON.parse(json), [
    'schema_version',
    'request',
    'context',
    'policy',
    'scope',
    'prepared_at',
    'approved_at',
    'proofs',
  ]);
  if (root.schema_version !== 1) throw new Error('MONEY_REVIEW_INVALID');
  const c = moneyFields(root.context, [
    'account',
    'wallet_account_id',
    'account_id',
    'deployment_digest',
    'policy_hash',
    'security_version',
    'entry_point',
    'nonce',
    'market',
    'native_asset_id',
    'gas',
    'budget',
    'checkpoint',
    'valid_until',
  ]);
  const market = moneyFields(c.market, ['document', 'digest']),
    g = moneyFields(c.gas, [
      'verificationGasLimit',
      'callGasLimit',
      'preVerificationGas',
      'maxFeePerGas',
      'maxPriorityFeePerGas',
    ]);
  const b = moneyFields(c.budget, [
    'usdc_available_atomic',
    'position_available_atomic',
    'native_available_atomic',
    'maximum_native_gas_atomic',
    'debt_base_atomic',
    'liquidity_atomic',
    'supply_capacity_atomic',
  ]);
  const cp = moneyFields(c.checkpoint, ['block_number', 'block_hash', 'observed_at', 'expires_at']);
  if (c.native_asset_id !== 'eip155:421614/slip44:60') throw new Error('MONEY_REVIEW_INVALID');
  const context: MoneyOperationContext = {
    account: moneyAddress(c.account),
    wallet_account_id: parseResourceId('walletAccount', c.wallet_account_id),
    account_id: hash(c.account_id),
    deployment_digest: hash(c.deployment_digest),
    policy_hash: hash(c.policy_hash),
    security_version: BigInt(parseAtomicAmount(c.security_version)),
    entry_point: moneyAddress(c.entry_point),
    nonce: BigInt(parseAtomicAmount(c.nonce)),
    market: { document: text(market.document), digest: hash(market.digest) },
    native_asset_id: c.native_asset_id,
    gas: {
      verificationGasLimit: BigInt(parseAtomicAmount(g.verificationGasLimit)),
      callGasLimit: BigInt(parseAtomicAmount(g.callGasLimit)),
      preVerificationGas: BigInt(parseAtomicAmount(g.preVerificationGas)),
      maxFeePerGas: BigInt(parseAtomicAmount(g.maxFeePerGas)),
      maxPriorityFeePerGas: BigInt(parseAtomicAmount(g.maxPriorityFeePerGas)),
    },
    budget: {
      usdc_available_atomic: parseAtomicAmount(b.usdc_available_atomic),
      position_available_atomic: parseAtomicAmount(b.position_available_atomic),
      native_available_atomic: parseAtomicAmount(b.native_available_atomic),
      maximum_native_gas_atomic: parseAtomicAmount(b.maximum_native_gas_atomic),
      debt_base_atomic: parseAtomicAmount(b.debt_base_atomic),
      liquidity_atomic: parseAtomicAmount(b.liquidity_atomic),
      supply_capacity_atomic:
        b.supply_capacity_atomic === null ? null : parseAtomicAmount(b.supply_capacity_atomic),
    },
    checkpoint: {
      block_number: parseAtomicAmount(cp.block_number),
      block_hash: hash(cp.block_hash),
      observed_at: moneyInteger(cp.observed_at),
      expires_at: moneyInteger(cp.expires_at),
    },
    valid_until: moneyInteger(c.valid_until),
  };
  const scope = moneyFields(root.scope, ['rpId', 'origin']);
  if (!Array.isArray(root.proofs) || root.proofs.length > 16)
    throw new Error('MONEY_REVIEW_INVALID');
  const proofs: MoneyProof[] = root.proofs.map((value) => {
    const proof = moneyFields(value, ['signerIndex', 'kind', 'assertion']);
    if (proof.kind !== 'webauthn') throw new Error('MONEY_CONSUMER_POLICY_REQUIRED');
    return {
      signerIndex: moneyInteger(proof.signerIndex, false),
      kind: 'webauthn',
      assertion: readAssertionRecord(proof.assertion),
    };
  });
  const review: MoneyConsentReview = {
    request: parseMoneyRequest(root.request),
    context,
    policy: consumerPolicy(root.policy),
    scope: { rpId: text(scope.rpId, 253), origin: text(scope.origin, 512) },
    prepared_at: moneyInteger(root.prepared_at),
    approved_at: moneyInteger(root.approved_at),
    proofs,
  };
  assertWebAuthnScope(review.scope);
  const candidate = prepareMoneyOperation(review.request, context, review.prepared_at);
  if (
    hashSecurityPolicy(review.policy) !== context.policy_hash ||
    review.approved_at < review.prepared_at ||
    review.approved_at >= context.valid_until ||
    writeMoneyReview(review).json !== json
  )
    throw new Error('MONEY_REVIEW_INVALID');
  return { review, candidate };
}
export function writeMoneyDraft(input: Omit<MoneyConsentReview, 'approved_at' | 'proofs'>) {
  const record = writeMoneyReview({ ...input, approved_at: input.prepared_at, proofs: [] });
  readMoneyDraft(record.json, record.digest);
  return record;
}
export function readMoneyDraft(json: unknown, digest: unknown) {
  const { review, candidate } = decodeReview(json, digest);
  if (review.proofs.length || review.approved_at !== review.prepared_at)
    throw new Error('MONEY_DRAFT_INVALID');
  const { request, context, policy, scope, prepared_at } = review;
  return Object.freeze({
    review: Object.freeze({ request, context, policy, scope, prepared_at }),
    candidate,
  });
}
/** Historical verification only. Current ownership, version, nonce, market and
 * funding require independent preflight; expiry never grants another send. */
export async function readMoneyReview(json: unknown, digest: unknown) {
  const { review, candidate } = decodeReview(json, digest);
  const signatures = await verifyTransferQuorum(
    candidate.digest,
    review.policy,
    review.scope,
    review.proofs,
  );
  const signature = encodeExecutionSignature(candidate.plan, signatures);
  if (size(signature) > 70_000) throw new Error('MONEY_SIGNATURE_TOO_LARGE');
  return Object.freeze({
    review,
    candidate,
    operation: Object.freeze({ ...candidate.operation, signature }),
  });
}
