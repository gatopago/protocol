import { parseResourceId } from './primitives';
import type { WebAuthnScope } from './webauthn';

const transports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const;
const invalid = (): never => {
  throw new Error('Invalid credential inventory');
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

/** Registration observations, NOT current authenticator availability or onchain
 * permissions. No raw credential ID, public key, proof, or identity subject.
 */
export function parseCredentialInventory(
  input: unknown,
  expected: WebAuthnScope,
  latestCreatedAt = 8_640_000_000_000,
) {
  // Default is the representable Date limit. Clients must not reject historical
  // metadata because their clock is slow. The repository supplies server time.
  if (
    !Number.isSafeInteger(latestCreatedAt) ||
    latestCreatedAt <= 0 ||
    latestCreatedAt > 8_640_000_000_000
  )
    return invalid();
  const value = object(input, ['scope', 'data', 'device_availability', 'onchain_authority']);
  const scope = object(value.scope, ['rpId', 'origin']);
  if (
    scope.rpId !== expected.rpId ||
    scope.origin !== expected.origin ||
    value.device_availability !== 'unknown' ||
    value.onchain_authority !== 'not_assessed' ||
    !Array.isArray(value.data) ||
    value.data.length > 16
  )
    return invalid();
  const ids = new Set<string>();
  const data = value.data.map((item: unknown) => {
    const row = object(item, [
      'credential_ref',
      'created_at',
      'transports',
      'aaguid',
      'backup_eligible',
      'backed_up_at_registration',
    ]);
    const id = parseResourceId('operation', row.credential_ref);
    if (ids.has(id)) return invalid();
    ids.add(id);
    if (
      typeof row.created_at !== 'number' ||
      !Number.isSafeInteger(row.created_at) ||
      row.created_at <= 0 ||
      row.created_at > latestCreatedAt ||
      typeof row.backup_eligible !== 'boolean' ||
      typeof row.backed_up_at_registration !== 'boolean' ||
      (row.backed_up_at_registration && !row.backup_eligible) ||
      typeof row.aaguid !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/.test(
        row.aaguid,
      ) ||
      !Array.isArray(row.transports) ||
      row.transports.length > transports.length ||
      !row.transports.every((item): item is (typeof transports)[number] =>
        transports.some((known) => known === item),
      ) ||
      new Set(row.transports).size !== row.transports.length
    )
      return invalid();
    return Object.freeze({
      credential_ref: id,
      created_at: row.created_at,
      transports: Object.freeze([...row.transports]),
      aaguid: row.aaguid,
      backup_eligible: row.backup_eligible,
      backed_up_at_registration: row.backed_up_at_registration,
    });
  });
  return Object.freeze({
    scope: Object.freeze({ ...expected }),
    data: Object.freeze(data),
    device_availability: 'unknown' as const,
    onchain_authority: 'not_assessed' as const,
  });
}

export type CredentialInventory = ReturnType<typeof parseCredentialInventory>;
