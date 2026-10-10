import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { hexToBigInt, hexToBytes, slice, toHex, type Hex } from 'viem';
import type { WebAuthnAccount } from 'viem/account-abstraction';
import type { PasskeyAssertion } from '../packages/shared/passkey';

/** Software passkey producing the same bytes as `navigator.credentials.get`. */
export function softwarePasskey(): WebAuthnAccount {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coordinate = (value: string) => Buffer.from(value, 'base64url').toString('hex');
  return {
    id: 'software-passkey',
    publicKey: `0x${coordinate(jwk.x!)}${coordinate(jwk.y!)}`,
    type: 'webAuthn',
    async sign({ hash }) {
      const authenticatorData = Buffer.concat([
        createHash('sha256').update('gatopago.com').digest(),
        Buffer.from([0x05, 0, 0, 0, 0]),
      ]);
      const challenge = Buffer.from(hash.slice(2), 'hex').toString('base64url');
      const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://gatopago.com","crossOrigin":false}`;
      const signed = Buffer.concat([
        authenticatorData,
        createHash('sha256').update(clientDataJSON).digest(),
      ]);
      return {
        signature: toHex(sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
        raw: {} as never,
        webauthn: {
          authenticatorData: toHex(authenticatorData),
          clientDataJSON,
          challengeIndex: 23,
          typeIndex: 1,
          userVerificationRequired: true,
        },
      };
    },
    async signMessage() {
      throw new Error('unused');
    },
    async signTypedData() {
      throw new Error('unused');
    },
  };
}

/** What ox's `WebAuthnP256.sign` returns for `passkey`, with an optional user handle. */
export async function passkeyAssertion(passkey: WebAuthnAccount, userHandle?: Hex) {
  const { signature, webauthn } = await passkey.sign({ hash: `0x${'cd'.repeat(32)}` });
  return {
    id: 'credential',
    metadata: webauthn,
    signature: {
      r: hexToBigInt(slice(signature, 0, 32)),
      s: hexToBigInt(slice(signature, 32, 64)),
    },
    raw: { response: { userHandle: userHandle ? hexToBytes(userHandle).buffer : null } },
  } as unknown as PasskeyAssertion;
}
