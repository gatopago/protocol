import { accountDomain, authorizationTypes } from './authorizations';
import { parseBackupPreview, type BackupSelection } from './backupWire';
import { verifyBackupEcdsaEnrollment } from './backupEnrollment';
import { SignerKind } from './securityPolicy';
import type { Hex } from 'viem';

const purpose = 'gatopago-v3-enrollment-proof';
const invalid = (): never => {
  throw new Error('EXTERNAL_ENROLLMENT_INVALID');
};
function review(choice: BackupSelection, wire: unknown, signerIndex: number, now: number) {
  const preview = parseBackupPreview(wire, choice),
    { compiled, receipt } = preview;
  if (
    !Number.isSafeInteger(now) ||
    receipt.state !== 'prepared' ||
    now < receipt.valid_after ||
    now >= receipt.valid_until
  ) {
    throw new Error('EXTERNAL_ENROLLMENT_EXPIRED');
  }
  if (!Number.isInteger(signerIndex)) return invalid();
  const proof = compiled.enrollments.find((item) => item.signerIndex === signerIndex),
    signer = compiled.nextPolicy.signers[signerIndex];
  if (!proof || signer?.kind !== SignerKind.ECDSA) return invalid();
  return { preview, proof, signer };
}

export function externalEnrollmentRequest(
  choice: BackupSelection,
  wire: unknown,
  signerIndex: number,
  now: number,
) {
  const { preview, proof, signer } = review(choice, wire, signerIndex, now),
    { compiled, receipt } = preview;
  const typedData = Object.freeze({
    domain: Object.freeze({
      ...accountDomain,
      chainId: compiled.initial.chainId,
      verifyingContract: compiled.initial.account,
    }),
    primaryType: 'EnrollmentProof' as const,
    types: Object.freeze({
      EIP712Domain: Object.freeze([
        Object.freeze({ name: 'name', type: 'string' }),
        Object.freeze({ name: 'version', type: 'string' }),
        Object.freeze({ name: 'chainId', type: 'uint256' }),
        Object.freeze({ name: 'verifyingContract', type: 'address' }),
      ]),
      EnrollmentProof: Object.freeze(
        authorizationTypes.EnrollmentProof.map((field) => Object.freeze({ ...field })),
      ),
    }),
    message: proof.message,
  });
  const summary = Object.freeze({
    schema_version: 1,
    purpose,
    backup_id: receipt.backup_id,
    signer_index: signerIndex,
    signer_address: signer.key,
    signer_roles: signer.roles,
    account: compiled.initial.account,
    network_id: compiled.initial.profile.deployment.network_id,
    proposal_hash: compiled.digest,
    policy_hash: compiled.message.nextPolicyHash,
    valid_after: receipt.valid_after,
    valid_until: receipt.valid_until,
    digest: proof.digest,
  });
  const json = JSON.stringify(
    { ...summary, policy: compiled.nextPolicy, typed_data: typedData },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  return Object.freeze({ summary, typedData, json });
}

export async function importExternalEnrollment(
  choice: BackupSelection,
  wire: unknown,
  signerIndex: number,
  text: string,
  now: number,
) {
  const { preview, proof } = review(choice, wire, signerIndex, now);
  if (
    typeof text !== 'string' ||
    text.length > 1024 ||
    new TextEncoder().encode(text).length > 1024
  )
    return invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const r = raw as Record<string, unknown>,
    fields = ['schema_version', 'purpose', 'backup_id', 'signer_index', 'digest', 'signature'];
  if (
    Object.keys(r).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(r, key)) ||
    r.schema_version !== 1 ||
    r.purpose !== purpose ||
    r.backup_id !== preview.receipt.backup_id ||
    r.signer_index !== signerIndex ||
    r.digest !== proof.digest ||
    typeof r.signature !== 'string' ||
    !/^0x[0-9a-f]{130}$/.test(r.signature)
  )
    return invalid();
  return verifyBackupEcdsaEnrollment(preview.input, signerIndex, r.signature as Hex, now);
}
