import type { Hex } from 'viem';
import { parseResourceId } from './primitives';
import { assertWebAuthnKey, type WebAuthnScope } from './webauthn';

const invalid = (): never => {
  throw new Error('Invalid credential detail');
};
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    return invalid();
  return value as Record<string, unknown>;
}

/** Owner-only public material for selecting a registered authenticator. This
 * does not prove current possession, device availability, or onchain authority.
 * Deliberately separate from the metadata-only inventory and its lighter bundle.
 */
export function parseCredentialDetail(
  input: unknown,
  expected: WebAuthnScope,
  expectedReference: string,
) {
  const reference = parseResourceId('operation', expectedReference);
  const value = object(input, [
    'scope',
    'credential_ref',
    'credential_id',
    'public_key',
    'device_availability',
    'onchain_authority',
  ]);
  const scope = object(value.scope, ['rpId', 'origin']);
  if (
    value.credential_ref !== reference ||
    scope.rpId !== expected.rpId ||
    scope.origin !== expected.origin ||
    value.device_availability !== 'unknown' ||
    value.onchain_authority !== 'not_assessed' ||
    typeof value.credential_id !== 'string' ||
    value.credential_id.length > 1366 ||
    !/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value.credential_id) ||
    typeof value.public_key !== 'string' ||
    !/^0x[0-9a-f]{256}$(?![\s\S])/.test(value.public_key)
  )
    return invalid();
  try {
    const decoded = atob(value.credential_id.replace(/-/g, '+').replace(/_/g, '/'));
    if (
      decoded.length < 1 ||
      decoded.length > 1024 ||
      btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !==
        value.credential_id
    )
      return invalid();
  } catch {
    return invalid();
  }
  const publicKey = value.public_key as Hex; // Canonical hex checked above; curve and scope checked below.
  assertWebAuthnKey(expected, publicKey);
  return Object.freeze({
    scope: Object.freeze({ ...expected }),
    credential_ref: reference,
    credential_id: value.credential_id,
    public_key: publicKey,
    device_availability: 'unknown' as const,
    onchain_authority: 'not_assessed' as const,
  });
}

export type CredentialDetail = ReturnType<typeof parseCredentialDetail>;
