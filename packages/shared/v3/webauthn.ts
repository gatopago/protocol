import { p256 } from '@noble/curves/nist.js';
import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  hexToBytes,
  numberToHex,
  sha256,
  stringToHex,
  type Hex,
} from 'viem';

export interface WebAuthnScope {
  rpId: string;
  origin: string;
}
export interface WebAuthnAssertionBytes {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signatureDER: Uint8Array;
}

export class WebAuthnEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnEncodingError';
  }
}
const fail = (message: string): never => {
  throw new WebAuthnEncodingError(message);
};
const SPKI_PREFIX = '0x3059301306072a8648ce3d020106082a8648ce3d030107034200';
const ASSERTION_ABI = [
  { type: 'bytes32' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes' },
  { type: 'string' },
] as const;

export function assertWebAuthnScope(scope: WebAuthnScope): void {
  if (
    !scope ||
    typeof scope.rpId !== 'string' ||
    typeof scope.origin !== 'string' ||
    scope.origin.length > 512 ||
    !/^[\x21-\x7e]+$/.test(scope.origin) ||
    scope.origin.includes('\\')
  )
    fail('Invalid WebAuthn scope');
  const rp = scope.rpId;
  if (
    rp !== 'localhost' &&
    (rp.length > 253 ||
      !rp.includes('.') ||
      /^\d+(\.\d+){3}$/.test(rp) ||
      !rp.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  )
    fail('Invalid RP ID');
  let origin: URL;
  try {
    origin = new URL(scope.origin);
  } catch {
    return fail('Invalid origin');
  }
  if (
    origin.origin !== scope.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && rp === 'localhost' && origin.hostname === 'localhost')) ||
    (origin.hostname !== rp && !origin.hostname.endsWith(`.${rp}`))
  )
    fail('Origin does not match RP ID');
}

export function webAuthnKeyFromSpki(scope: WebAuthnScope, spki: Uint8Array): Hex {
  assertWebAuthnScope(scope);
  if (
    !(spki instanceof Uint8Array) ||
    spki.length !== 91 ||
    bytesToHex(spki.subarray(0, 26)) !== SPKI_PREFIX ||
    spki[26] !== 4
  )
    fail('Expected named-curve P-256 SPKI');
  try {
    p256.Point.fromHex(spki.subarray(26)).assertValidity();
  } catch {
    return fail('Invalid P-256 public key');
  }
  return concatHex([
    sha256(stringToHex(scope.rpId)),
    sha256(stringToHex(scope.origin)),
    bytesToHex(spki.subarray(27)),
  ]);
}

export function assertWebAuthnChallenge(challenge: Hex): void {
  if (typeof challenge !== 'string' || !/^0x[0-9a-f]{64}$/.test(challenge))
    fail('Expected a canonical 32-byte challenge');
}

export function assertWebAuthnKey(scope: WebAuthnScope, key: Hex): void {
  assertWebAuthnScope(scope);
  if (
    typeof key !== 'string' ||
    !/^0x[0-9a-f]{256}$/.test(key) ||
    key.slice(0, 66) !== sha256(stringToHex(scope.rpId)) ||
    `0x${key.slice(66, 130)}` !== sha256(stringToHex(scope.origin))
  )
    fail('Signer key does not match scope');
  try {
    p256.Point.fromHex(`04${key.slice(130)}`).assertValidity();
  } catch {
    return fail('Invalid P-256 public key');
  }
}

export function normalizeWebAuthnSignature(der: Uint8Array): { r: Hex; s: Hex } {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 72)
    fail('Invalid ES256 DER length');
  try {
    const parsed = p256.Signature.fromDER(der).normalizeS();
    return { r: numberToHex(parsed.r, { size: 32 }), s: numberToHex(parsed.s, { size: 32 }) };
  } catch {
    return fail('Invalid ES256 DER signature');
  }
}

export function encodeWebAuthnAssertion(input: {
  scope: WebAuthnScope;
  key: Hex;
  challenge: Hex;
  response: WebAuthnAssertionBytes;
}): Hex {
  const { scope, key, challenge, response } = input;
  assertWebAuthnKey(scope, key);
  assertWebAuthnChallenge(challenge);
  const { authenticatorData: data, clientDataJSON: jsonBytes, signatureDER } = response;
  if (
    !(data instanceof Uint8Array) ||
    data.length < 37 ||
    data.length > 1024 ||
    !(jsonBytes instanceof Uint8Array) ||
    jsonBytes.length === 0 ||
    jsonBytes.length > 2048
  )
    fail('Invalid assertion size');
  if (bytesToHex(data.subarray(0, 32)) !== sha256(stringToHex(scope.rpId)))
    fail('Authenticator RP mismatch');
  const flags = data[32];
  if ((flags & 5) !== 5 || ((flags & 16) !== 0 && (flags & 8) === 0))
    fail('User verification or backup flags invalid');
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(jsonBytes);
  } catch {
    return fail('Invalid UTF-8 client data');
  }
  const challenge64 = btoa(String.fromCharCode(...hexToBytes(challenge)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  const prefix = `{"type":"webauthn.get","challenge":"${challenge64}","origin":"${scope.origin}","crossOrigin":false`;
  if (!json.startsWith(prefix) || !['}', ','].includes(json[prefix.length]))
    fail('Client data does not match the V3 assertion profile');

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      parsed.type !== 'webauthn.get' ||
      parsed.challenge !== challenge64 ||
      parsed.origin !== scope.origin ||
      parsed.crossOrigin !== false ||
      Object.hasOwn(parsed, 'topOrigin')
    )
      fail('Ambiguous client data');
  } catch {
    return fail('Invalid or ambiguous client data');
  }
  const { r, s } = normalizeWebAuthnSignature(signatureDER);
  const hash = sha256(concatHex([bytesToHex(data), sha256(jsonBytes)]));
  const publicKey = hexToBytes(`0x04${key.slice(130)}`);
  if (
    !p256.verify(hexToBytes(concatHex([r, s])), hexToBytes(hash), publicKey, {
      lowS: true,
      prehash: false,
    })
  )
    fail('Invalid assertion signature');
  const encoded = encodeAbiParameters(ASSERTION_ABI, [r, s, 23n, 1n, bytesToHex(data), json]);
  if ((encoded.length - 2) / 2 > 4096) fail('Encoded assertion too large');
  return encoded;
}
