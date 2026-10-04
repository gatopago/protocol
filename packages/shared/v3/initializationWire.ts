import type { Hex } from 'viem';
import { requireHash } from './deployment';
import { prepareInitialization, type InitializationInput } from './initialization';
import { parseResourceId } from './primitives';
import type { WebAuthnAssertionBytes, WebAuthnScope } from './webauthn';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('Invalid initialization fields');
  return value as Record<string, unknown>;
}
function binary(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value)
  )
    throw new Error('Invalid initialization bytes');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  const canonical = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  if (bytes.length < min || bytes.length > max || canonical !== value)
    throw new Error('Invalid initialization bytes');
  return bytes;
}
export function parseInitializationRequest(value: unknown) {
  const r = object(value, [
    'request_id',
    'credential_ref',
    'profile_sha256',
    'user_salt_commitment',
  ]);
  requireHash(r.profile_sha256);
  requireHash(r.user_salt_commitment);
  return Object.freeze({
    id: parseResourceId('operation', r.request_id),
    credentialRef: parseResourceId('operation', r.credential_ref),
    profileDigest: r.profile_sha256,
    userSaltCommitment: r.user_salt_commitment,
  });
}
export function parseInitializationProof(value: unknown): WebAuthnAssertionBytes {
  const r = object(value, ['authenticator_data', 'client_data', 'signature']);
  return {
    authenticatorData: binary(r.authenticator_data, 37, 1024),
    clientDataJSON: binary(r.client_data, 1, 2048),
    signatureDER: binary(r.signature, 8, 72),
  };
}

const receiptFields = [
  'initialization_id',
  'state',
  'approval_digest',
  'profile_sha256',
  'account_deployed',
  'receive_enabled',
  'spend_enabled',
] as const;
export function parseInitializationReceipt(
  value: unknown,
  expected: { id: string; profileDigest: Hex; approvalDigest?: Hex },
) {
  const r = object(value, receiptFields);
  const id = parseResourceId('operation', r.initialization_id);
  requireHash(r.approval_digest);
  requireHash(r.profile_sha256);
  if (
    id !== expected.id ||
    r.profile_sha256 !== expected.profileDigest ||
    (expected.approvalDigest && r.approval_digest !== expected.approvalDigest) ||
    (r.state !== 'prepared' && r.state !== 'authorized') ||
    r.account_deployed !== false ||
    r.receive_enabled !== false ||
    r.spend_enabled !== false
  )
    throw new Error('Invalid initialization receipt');
  return Object.freeze({
    initialization_id: id,
    state: r.state,
    approval_digest: r.approval_digest,
    profile_sha256: r.profile_sha256,
    account_deployed: false as const,
    receive_enabled: false as const,
    spend_enabled: false as const,
  });
}

export function parseInitializationPreparation(
  value: unknown,
  expected: {
    id: string;
    credentialRef: string;
    document: string;
    profileDigest: Hex;
    userSaltCommitment: Hex;
    scope: WebAuthnScope;
  },
) {
  const r = object(value, [
    ...receiptFields,
    'credential_ref',
    'credential_id',
    'public_key',
    'valid_after',
    'valid_until',
  ]);
  const receipt = parseInitializationReceipt(
    Object.fromEntries(receiptFields.map((key) => [key, r[key]])),
    expected,
  );
  const credentialRef = parseResourceId('operation', r.credential_ref);
  binary(r.credential_id, 1, 1024);
  if (
    credentialRef !== expected.credentialRef ||
    typeof r.credential_id !== 'string' ||
    typeof r.public_key !== 'string' ||
    !/^0x[0-9a-f]{256}$(?![\s\S])/.test(r.public_key) ||
    typeof r.valid_after !== 'number' ||
    typeof r.valid_until !== 'number'
  )
    throw new Error('Invalid initialization preparation');
  const input: InitializationInput = Object.freeze({
    document: expected.document,
    expectedDigest: expected.profileDigest,
    scope: Object.freeze({ ...expected.scope }),
    publicKey: r.public_key as Hex,
    userSaltCommitment: expected.userSaltCommitment,
    validAfter: r.valid_after,
    validUntil: r.valid_until,
  });
  const prepared = prepareInitialization(input);
  if (prepared.digest !== receipt.approval_digest)
    throw new Error('Initialization digest mismatch');
  return Object.freeze({
    ...receipt,
    credential_ref: credentialRef,
    credential_id: r.credential_id,
    public_key: input.publicKey,
    valid_after: input.validAfter,
    valid_until: input.validUntil,
  });
}

const historyFields = [
  'initialization_id',
  'credential_ref',
  'profile_sha256',
  'approval_digest',
  'created_at',
  'expires_at',
  'state',
  'creation_operation_recorded',
] as const;
function timestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 8_640_000_000_000
  );
}
export function parseInitializationCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 64)
    throw new Error('Invalid initialization cursor');
  const parts = /^v1:([1-9][0-9]{0,12}):(op_[0-9a-f-]{36})$(?![\s\S])/.exec(value);
  if (!parts || !timestamp(Number(parts[1]))) throw new Error('Invalid initialization cursor');
  return Object.freeze({ createdAt: Number(parts[1]), id: parseResourceId('operation', parts[2]) });
}
export function parseInitializationHistory(value: unknown) {
  const r = object(value, ['observed_at', 'data', 'next_cursor']);
  if (!timestamp(r.observed_at) || !Array.isArray(r.data) || r.data.length > 10)
    throw new Error('Invalid initialization history');
  const observedAt = r.observed_at,
    seen = new Set<string>();
  const data = r.data.map((value: unknown) => {
    const row = object(value, historyFields),
      id = parseResourceId('operation', row.initialization_id),
      credentialRef = parseResourceId('operation', row.credential_ref);
    requireHash(row.profile_sha256);
    requireHash(row.approval_digest);
    if (
      seen.has(id) ||
      !timestamp(row.created_at) ||
      !timestamp(row.expires_at) ||
      row.created_at > observedAt ||
      row.expires_at !== row.created_at + 300 ||
      typeof row.creation_operation_recorded !== 'boolean' ||
      (row.state !== 'prepared' && row.state !== 'authorized' && row.state !== 'expired') ||
      (row.state === 'prepared' && row.expires_at <= observedAt) ||
      (row.state === 'expired' && row.expires_at > observedAt) ||
      (row.creation_operation_recorded && row.state !== 'authorized')
    )
      throw new Error('Invalid initialization history');
    seen.add(id);
    return Object.freeze({
      initialization_id: id,
      credential_ref: credentialRef,
      profile_sha256: row.profile_sha256,
      approval_digest: row.approval_digest,
      created_at: row.created_at,
      expires_at: row.expires_at,
      state: row.state,
      creation_operation_recorded: row.creation_operation_recorded,
    });
  });
  for (let i = 1; i < data.length; i++) {
    if (
      data[i].created_at > data[i - 1].created_at ||
      (data[i].created_at === data[i - 1].created_at &&
        data[i].initialization_id >= data[i - 1].initialization_id)
    )
      throw new Error('Invalid history order');
  }
  let cursor: string | null = null;
  if (r.next_cursor !== null) {
    const parsed = parseInitializationCursor(r.next_cursor),
      last = data.at(-1);
    if (
      data.length !== 10 ||
      !last ||
      parsed.createdAt !== last.created_at ||
      parsed.id !== last.initialization_id
    )
      throw new Error('Invalid history cursor');
    cursor = r.next_cursor as string;
  }
  return Object.freeze({ observed_at: observedAt, data: Object.freeze(data), next_cursor: cursor });
}
export type InitializationHistoryItem = ReturnType<
  typeof parseInitializationHistory
>['data'][number];

export function parseInitializationRestoration(
  value: unknown,
  selected: InitializationHistoryItem,
  pin: { document: string; digest: Hex },
  scope: WebAuthnScope,
) {
  const r = object(value, ['preparation', 'user_salt_commitment', 'creation_operation_recorded']);
  requireHash(r.user_salt_commitment);
  if (selected.profile_sha256 !== pin.digest || typeof r.creation_operation_recorded !== 'boolean')
    throw new Error('Invalid initialization restoration');
  const expected = Object.freeze({
    id: selected.initialization_id,
    credentialRef: selected.credential_ref,
    document: pin.document,
    profileDigest: pin.digest,
    userSaltCommitment: r.user_salt_commitment,
    scope: Object.freeze({ ...scope }),
  });
  const preparation = parseInitializationPreparation(r.preparation, expected);
  if (
    preparation.approval_digest !== selected.approval_digest ||
    preparation.valid_after !== selected.created_at ||
    preparation.valid_until !== selected.expires_at ||
    (selected.state === 'authorized' && preparation.state !== 'authorized') ||
    (r.creation_operation_recorded && preparation.state !== 'authorized') ||
    (selected.creation_operation_recorded && !r.creation_operation_recorded)
  )
    throw new Error('Invalid restored consent');
  return Object.freeze({
    consent: Object.freeze({ preparation, expected }),
    creationOperationRecorded: r.creation_operation_recorded,
  });
}
