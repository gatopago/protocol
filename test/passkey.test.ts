import { afterEach, describe, expect, it, vi } from 'vitest';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { bytesToHex, hexToBigInt, sha256, slice, stringToBytes } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { createEd25519SigningSession, getPasskeyPrfOutput } from '@category-labs/mera';
import {
  BUSINESS_KEY_SALT,
  businessKey,
  businessSignInMessage,
  capturingWebAuthnClient,
  meraEvmKey,
  meraSeed,
} from '../packages/shared/passkey';
import { softwarePasskey } from './passkey';

describe('passkeys', () => {
  it("derive Mera's Ethereum key as any BIP-39 wallet does from the same phrase", () => {
    const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = meraEvmKey(meraSeed(prfOutput));
    expect(privateKeyToAccount(bytesToHex(key)).address).toBe(
      mnemonicToAccount(entropyToMnemonic(prfOutput, wordlist)).address,
    );
  });

  it("ask Mera's fixed PRF salt: another one would derive other keys for every account", async () => {
    let salt: Uint8Array | undefined;
    await getPasskeyPrfOutput({
      rpId: 'gatopago.com',
      webAuthnClient: {
        createCredential: () => Promise.reject(new Error('unused')),
        getCredential: async ({ prfSalt }) => {
          salt = prfSalt;
          throw new Error('stop');
        },
      },
    }).catch(() => undefined);
    expect(bytesToHex(salt!)).toBe(bytesToHex(sha256(stringToBytes('mera.prf.salt.v1'), 'bytes')));
  });

  it('derive a Business sign-in key that is the same on every device and apart from Mera', async () => {
    // The salt is fixed: changing it changes every Business key.
    expect(bytesToHex(BUSINESS_KEY_SALT)).toBe(
      '0x4c2e79b7826f5fe8839d979f12df9d7bbc8247e32eed6364aa41ba85b6f4b2df',
    );
    const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = await businessKey(prfOutput);
    expect(key).toHaveLength(32);
    expect(await businessKey(prfOutput.slice())).toEqual(key);
    expect(await businessKey(prfOutput.map((byte) => byte ^ 1))).not.toEqual(key);
    expect(bytesToHex(key)).not.toBe(bytesToHex(meraEvmKey(meraSeed(prfOutput.slice()))));
    // Its signatures verify with the standard Ed25519 of Web Crypto, as Wallet Core checks them.
    const session = createEd25519SigningSession({ privateKey: key.slice() });
    const message = businessSignInMessage('https://business.gatopago.com', 'a1b2c3d4e5f6a7b8');
    const signature = await session.signMessage(message);
    const publicKey = await crypto.subtle.importKey('raw', session.publicKey, 'Ed25519', false, [
      'verify',
    ]);
    expect(await crypto.subtle.verify('Ed25519', publicKey, signature, message)).toBe(true);
    session.end();
  });

  it('store the account a backup key opens as its user handle, on the kind of key asked for', async () => {
    let asked: {
      publicKey?: {
        user?: { id?: Uint8Array };
        authenticatorSelection?: { authenticatorAttachment?: string };
      };
    } = {};
    vi.stubGlobal('window', {
      navigator: {
        credentials: {
          create: async (options: typeof asked) => {
            asked = options;
            throw new Error('dismissed');
          },
        },
      },
    });
    const account = new Uint8Array(20).fill(0x22);
    const { client } = capturingWebAuthnClient({
      userHandle: account,
      attachment: 'cross-platform',
    });
    await expect(
      client.createCredential({
        rp: { id: 'gatopago.com', name: 'GatoPago' },
        user: { id: new Uint8Array(16), name: 'backup', displayName: 'backup' },
        challenge: new Uint8Array(32),
        algorithms: [-7],
        prfSalt: new Uint8Array(32),
        residentKey: 'required',
        userVerification: 'required',
        attestation: 'none',
      }),
    ).rejects.toThrow();
    expect(asked.publicKey?.user?.id).toEqual(account);
    expect(asked.publicKey?.authenticatorSelection?.authenticatorAttachment).toBe('cross-platform');
  });

  it('hand the browser the time limit of a prompt, and end it when it passes', async () => {
    let asked: { publicKey?: { timeout?: number }; signal?: AbortSignal } = {};
    vi.stubGlobal('window', {
      navigator: {
        credentials: {
          get: async (options: typeof asked) => {
            asked = options;
            throw new Error('dismissed');
          },
        },
      },
    });
    const { client } = capturingWebAuthnClient();
    await expect(
      client.getCredential({
        rpId: 'gatopago.com',
        challenge: new Uint8Array(32),
        prfSalt: new Uint8Array(32),
        userVerification: 'required',
        timeout: 120_000,
      }),
    ).rejects.toThrow();
    expect(asked.publicKey?.timeout).toBe(120_000);
    expect(asked.signal).toBeInstanceOf(AbortSignal);
  });
});

afterEach(() => vi.unstubAllGlobals());
