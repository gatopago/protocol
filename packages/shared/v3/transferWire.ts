import type { Hex } from 'viem';
import { requireHash } from './deployment';
import { parseInitializationProof } from './initializationWire';
import type { authorizeTransferOperation } from './transferAuthorization';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))) throw new Error('INVALID_TRANSFER_REQUEST');
  return value as Record<string, unknown>;
}

/** Public-key proof transport only. No policy, budget, network/provider override
 * or possession claim. Actual signature verification remains in Wallet Core. */
export function parseTransferConfirmation(value: unknown) {
  const root = object(value, ['consent_digest', 'proofs']);
  requireHash(root.consent_digest);
  if (!Array.isArray(root.proofs) || root.proofs.length < 1 || root.proofs.length > 16) throw new Error('INVALID_TRANSFER_REQUEST');
  const seen = new Set<number>();
  const proofs: Parameters<typeof authorizeTransferOperation>[3] = root.proofs.map((value: unknown) => {
    if (!value || typeof value !== 'object' || !('kind' in value)) throw new Error('INVALID_TRANSFER_REQUEST');
    const row = object(value, value.kind === 'webauthn' ? ['signer_index', 'kind', 'assertion'] : ['signer_index', 'kind', 'signature']);
    if (typeof row.signer_index !== 'number' || !Number.isInteger(row.signer_index) || row.signer_index < 0 || row.signer_index > 15
      || seen.has(row.signer_index)) throw new Error('INVALID_TRANSFER_REQUEST');
    const signerIndex = row.signer_index; seen.add(signerIndex);
    if (row.kind === 'webauthn') return { signerIndex, kind: 'webauthn', assertion: parseInitializationProof(row.assertion) };
    if (row.kind !== 'ecdsa' || typeof row.signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$(?![\s\S])/.test(row.signature)) {
      throw new Error('INVALID_TRANSFER_REQUEST');
    }
    return { signerIndex, kind: 'ecdsa', signature: row.signature as Hex };
  });
  return { consent_digest: root.consent_digest, proofs };
}

export function parseTransferDelivery(value: unknown) {
  const row = object(value, ['consent_digest']); requireHash(row.consent_digest);
  return { consent_digest: row.consent_digest };
}

/** Encode public proofs from an explicit signing ceremony. Never triggers one. */
export function serializeTransferConfirmation(consentDigest: Hex, input: Parameters<typeof authorizeTransferOperation>[3]) {
  const proofs = structuredClone(input);
  const binary = (value: Uint8Array, max: number) => {
    if (!(value instanceof Uint8Array) || value.length > max) throw new Error('INVALID_TRANSFER_REQUEST');
    return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  };
  if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > 16) throw new Error('INVALID_TRANSFER_REQUEST');
  const wire = { consent_digest: consentDigest, proofs: proofs.map(p => p.kind === 'webauthn'
    ? { signer_index: p.signerIndex, kind: p.kind, assertion: { authenticator_data: binary(p.assertion.authenticatorData, 1024),
      client_data: binary(p.assertion.clientDataJSON, 2048), signature: binary(p.assertion.signatureDER, 72) } }
    : { signer_index: p.signerIndex, kind: p.kind, signature: p.signature }) };
  parseTransferConfirmation(wire);
  return wire;
}
