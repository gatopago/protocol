import { describe, expect, it } from 'vitest';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { bytesToHex, encodeFunctionData, hexToBigInt, hexToBytes, slice, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { walletContracts } from '../packages/shared/networks';
import {
  meraEvmKey,
  meraSeed,
  passkeyAccount,
  recoverPasskeyPublicKeys,
  type AccountApprovals,
  type PasskeyAssertion,
} from '../packages/shared/passkey';
import { gatopagoAccountAbi, passkeyOwner } from '../packages/shared/wallet';
import { softwarePasskey } from './passkey';

/** What ox's `WebAuthnP256.sign` returns for `passkey`, with an optional user handle. */
async function assertion(passkey: ReturnType<typeof softwarePasskey>, userHandle?: Hex) {
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

describe('passkeys', () => {
  it('recover the signing key among the two candidates of a WebAuthn assertion', async () => {
    const passkey = softwarePasskey();
    const { signature, webauthn } = await passkey.sign({ hash: `0x${'ab'.repeat(32)}` });
    const candidates = recoverPasskeyPublicKeys(webauthn, {
      r: hexToBigInt(slice(signature, 0, 32)),
      s: hexToBigInt(slice(signature, 32, 64)),
    });
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(passkey.publicKey);
  });

  it('find the account whose current owners include the passkey, with one assertion', async () => {
    const [phone, backup] = [softwarePasskey(), softwarePasskey()];
    const owner = (key: { publicKey: Hex }) =>
      passkeyOwner(walletContracts.webAuthnVerifier, key.publicKey);
    const address = '0x3333333333333333333333333333333333333333';
    const change = (functionName: 'addOwners' | 'removeOwners', owners: Hex[]) => ({
      call: encodeFunctionData({ abi: gatopagoAccountAbi, functionName, args: [owners] }),
    });
    let known: AccountApprovals | null = { initial_owners: null, approvals: [] };
    const lookup = {
      accountOf: async (owners: readonly Hex[]) =>
        owners[0] === owner(phone) ? address : '0x4444444444444444444444444444444444444444',
      approvals: async (account: string) => (account === address ? known : null),
    } as const;

    // Before any approval the address is all the server knows: it derives from the passkey.
    expect(await passkeyAccount(await assertion(phone), lookup)).toEqual({
      credentialId: 'credential',
      publicKey: phone.publicKey,
      address,
      initialOwners: [owner(phone)],
    });
    // A backup passkey names its account in the user handle; it counts once approved.
    known = { initial_owners: [owner(phone)], approvals: [change('addOwners', [owner(backup)])] };
    expect((await passkeyAccount(await assertion(backup, address), lookup))?.address).toBe(address);
    // A removed passkey, or one of nobody's account, finds nothing.
    known = {
      initial_owners: [owner(phone)],
      approvals: [change('addOwners', [owner(backup)]), change('removeOwners', [owner(phone)])],
    };
    expect(await passkeyAccount(await assertion(phone), lookup)).toBe(null);
    expect(await passkeyAccount(await assertion(softwarePasskey()), lookup)).toBe(null);
  });

  it("derive Mera's Ethereum key as any BIP-39 wallet does from the same phrase", () => {
    const prfOutput = Uint8Array.from({ length: 32 }, (_, i) => i);
    const key = meraEvmKey(meraSeed(prfOutput));
    expect(privateKeyToAccount(bytesToHex(key)).address).toBe(
      mnemonicToAccount(entropyToMnemonic(prfOutput, wordlist)).address,
    );
  });
});
