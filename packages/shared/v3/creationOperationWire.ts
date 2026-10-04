import { parsePaymasterTerms } from './paymaster';
import { prepareCreationOperation, type CreationGasTerms } from './creationOperation';
import { requireHash } from './deployment';
import { parseInitializationPreparation, parseInitializationProof } from './initializationWire';
import { parseResourceId } from './primitives';
import { parseCreationLifecycle } from './creationLifecycle';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('Invalid creation fields');
  return value as Record<string, unknown>;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,77})$(?![\s\S])/.test(value))
    throw new Error('Invalid creation amount');
  const result = BigInt(value);
  if (result >= 1n << 256n) throw new Error('Invalid creation amount');
  return result;
}
const gasFields = [
  'verificationGasLimit',
  'callGasLimit',
  'preVerificationGas',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'maximumGasCharge',
] as const;
export function parseCreationGas(value: unknown): CreationGasTerms {
  const sponsored = !!value && typeof value === 'object' && Object.hasOwn(value, 'sponsorship');
  const r = object(value, sponsored ? [...gasFields, 'sponsorship'] : gasFields);
  return Object.freeze({
    verificationGasLimit: decimal(r.verificationGasLimit),
    callGasLimit: decimal(r.callGasLimit),
    preVerificationGas: decimal(r.preVerificationGas),
    maxFeePerGas: decimal(r.maxFeePerGas),
    maxPriorityFeePerGas: decimal(r.maxPriorityFeePerGas),
    maximumGasCharge: decimal(r.maximumGasCharge),
    ...(sponsored ? { sponsorship: parsePaymasterTerms(r.sponsorship) } : {}),
  });
}
export function creationGasWire(terms: CreationGasTerms) {
  const value = Object.fromEntries(
    gasFields.map((field) => {
      if (typeof terms[field] !== 'bigint') throw new Error('Invalid creation gas');
      return [field, terms[field].toString()];
    }),
  );
  const wire = {
    ...value,
    ...(terms.sponsorship ? { sponsorship: parsePaymasterTerms(terms.sponsorship) } : {}),
  };
  parseCreationGas(wire);
  return Object.freeze(wire);
}

export function parseCreationCapRequest(value: unknown): bigint {
  const cap = decimal(object(value, ['maximum_gas_charge']).maximum_gas_charge);
  if (cap === 0n) throw new Error('Invalid creation cap');
  return cap;
}

const receiptFields = [
  'initialization_id',
  'state',
  'user_op_hash',
  'operation_digest',
  'expires_at',
  'authorization_expired',
  'delivery_state',
  'deployment_assessment',
  'receive_enabled',
  'spend_enabled',
] as const;
export function parseCreationReceipt(
  value: unknown,
  expected: { id: string; userOpHash: string; digest: string; expiresAt: number },
) {
  const r = object(value, receiptFields),
    id = parseResourceId('operation', r.initialization_id);
  requireHash(r.user_op_hash);
  requireHash(r.operation_digest);
  if (
    id !== expected.id ||
    r.user_op_hash !== expected.userOpHash ||
    r.operation_digest !== expected.digest ||
    r.expires_at !== expected.expiresAt ||
    (r.state !== 'prepared' && r.state !== 'authorized') ||
    typeof r.authorization_expired !== 'boolean' ||
    (r.delivery_state !== 'not_requested' &&
      r.delivery_state !== 'pending' &&
      r.delivery_state !== 'sending' &&
      r.delivery_state !== 'uncertain' &&
      r.delivery_state !== 'accepted' &&
      r.delivery_state !== 'expired') ||
    (r.state === 'prepared') !== (r.delivery_state === 'not_requested') ||
    r.deployment_assessment !== 'not_assessed' ||
    r.receive_enabled !== false ||
    r.spend_enabled !== false
  )
    throw new Error('Invalid creation receipt');
  return Object.freeze({
    initialization_id: id,
    state: r.state,
    user_op_hash: r.user_op_hash,
    operation_digest: r.operation_digest,
    expires_at: expected.expiresAt,
    authorization_expired: r.authorization_expired,
    delivery_state: r.delivery_state,
    deployment_assessment: 'not_assessed' as const,
    receive_enabled: false as const,
    spend_enabled: false as const,
  });
}
export type CreationConsent = Readonly<{
  preparation: ReturnType<typeof parseInitializationPreparation>;
  expected: Parameters<typeof parseInitializationPreparation>[1];
}>;

export function parseCreationPreview(value: unknown, consent: CreationConsent) {
  const r = object(value, [
    'receipt',
    'initial_assertion',
    'gas_terms',
    'observed_at',
    'lifecycle',
  ]);
  const p = parseInitializationPreparation(consent.preparation, consent.expected);
  if (
    p.state !== 'authorized' ||
    typeof r.observed_at !== 'number' ||
    !Number.isSafeInteger(r.observed_at) ||
    r.observed_at < p.valid_after ||
    r.observed_at > 8_640_000_000_000
  )
    throw new Error('Invalid creation observation');
  const terms = parseCreationGas(r.gas_terms),
    initialProof = parseInitializationProof(r.initial_assertion);
  const candidate = prepareCreationOperation(
    {
      document: consent.expected.document,
      expectedDigest: consent.expected.profileDigest,
      scope: consent.expected.scope,
      userSaltCommitment: consent.expected.userSaltCommitment,
      publicKey: p.public_key,
      validAfter: p.valid_after,
      validUntil: p.valid_until,
    },
    initialProof,
    terms,
    p.valid_after,
  );
  const receipt = parseCreationReceipt(r.receipt, {
    id: p.initialization_id,
    userOpHash: candidate.userOpHash,
    digest: candidate.digest,
    expiresAt: p.valid_until,
  });
  if (receipt.authorization_expired !== r.observed_at >= p.valid_until)
    throw new Error('Invalid creation expiry');
  const lifecycle = parseCreationLifecycle(r.lifecycle, receipt, r.observed_at);
  return Object.freeze({ receipt, terms, candidate, lifecycle, observedAt: r.observed_at });
}
