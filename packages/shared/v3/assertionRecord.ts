import { bytesToHex, hexToBytes, type Hex } from 'viem';
import type { WebAuthnAssertionBytes } from './webauthn';

const fields = ['authenticatorData', 'clientDataJSON', 'signatureDER'] as const;
const bounds = {
  authenticatorData: [37, 1024],
  clientDataJSON: [1, 2048],
  signatureDER: [8, 72],
} as const;

export function writeAssertionRecord(proof: WebAuthnAssertionBytes): string {
  return JSON.stringify(
    Object.fromEntries(
      fields.map((field) => {
        const value = proof[field],
          [min, max] = bounds[field];
        if (!(value instanceof Uint8Array) || value.length < min || value.length > max)
          throw new Error('Invalid assertion record');
        return [field, bytesToHex(value)];
      }),
    ),
  );
}

export function readAssertionRecord(value: unknown): WebAuthnAssertionBytes {
  if (typeof value !== 'string' || value.length > 7000) throw new Error('Invalid assertion record');
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3
  )
    throw new Error('Invalid assertion record');
  const record = parsed;
  function field(name: (typeof fields)[number]) {
    const encoded: unknown = Reflect.get(record, name),
      [min, max] = bounds[name];
    if (
      typeof encoded !== 'string' ||
      encoded.length < 2 + min * 2 ||
      encoded.length > 2 + max * 2 ||
      !/^0x(?:[0-9a-f]{2})+$(?![\s\S])/.test(encoded)
    )
      throw new Error('Invalid assertion record');
    return hexToBytes(encoded as Hex);
  }
  const proof = {
    authenticatorData: field('authenticatorData'),
    clientDataJSON: field('clientDataJSON'),
    signatureDER: field('signatureDER'),
  };
  if (writeAssertionRecord(proof) !== value) throw new Error('Noncanonical assertion record');
  return proof;
}
