import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { toHex } from 'viem';
import type { WebAuthnAccount } from 'viem/account-abstraction';

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
