import { afterEach, describe, expect, it, vi } from 'vitest';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { bytesToHex, hexToBigInt, slice } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { capturingWebAuthnClient, meraEvmKey, meraSeed } from '../packages/shared/passkey';
import { softwarePasskey } from './passkey';

describe('passkeys', () => {
  it("derive Mera's Ethereum key as any BIP-39 wallet does from the same phrase", () => {
    const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = meraEvmKey(meraSeed(prfOutput));
    expect(privateKeyToAccount(bytesToHex(key)).address).toBe(
      mnemonicToAccount(entropyToMnemonic(prfOutput, wordlist)).address,
    );
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
