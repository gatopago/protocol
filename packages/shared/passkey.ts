import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { WebAuthnClient } from '@category-labs/mera';
import { Base64, PublicKey, WebAuthnP256 } from 'ox';
import { bytesToHex, getAddress, stringToBytes, type Address, type Client, type Hex } from 'viem';
import { getCode, readContract } from 'viem/actions';
import { gatopagoAccountAbi, keyOwner, verifiedOwners, type WalletContracts } from './wallet';

/**
 * How a passkey identifies a GatoPago account, shared by the app and the merchant console so both
 * always find the same one, with one prompt: every account is owned by the keys Mera derives from
 * its passkeys' PRF outputs.
 */

/** A passkey assertion, as ox's `WebAuthnP256.sign` returns it. */
export type PasskeyAssertion = Awaited<ReturnType<typeof WebAuthnP256.sign>>;

/** What the app knows of an account (`GET /app/v1/approvals/:address`). */
export interface AccountApprovals {
  readonly initial_owners: Hex[] | null;
  readonly approvals: readonly { sequence: number; call: Hex; signature: Hex }[];
}

/**
 * The account a passkey opens, from the assertion that returned its PRF output: `owner`, the key
 * Mera derives from that output, must own it now by its history, verified here (`verifiedOwners`),
 * not as a server tells. The account is the one the passkey's user handle names (a backup key), or
 * the one `owner` created (its only initial owner). `accountOf` is the address the factory derives
 * from initial owners; `approvals` what Wallet Core knows of an address, null when it is not a
 * member's. Wallet Core is a convenience, not the key: an account it does not know (a database
 * reset or lost) is still found by the chain if `owner` created it, so it can sign in and be
 * registered again. `client` reads the home network.
 */
export async function findAccount(
  client: Client,
  {
    contracts,
    assertion: { raw },
    owner,
    lookup,
  }: {
    /** The contracts accounts are made with (`walletContracts`). */
    contracts: Pick<WalletContracts, 'factory'>;
    assertion: PasskeyAssertion;
    owner: Address;
    lookup: {
      accountOf(owners: readonly Hex[]): Promise<Address>;
      approvals(address: Address): Promise<AccountApprovals | null>;
    };
  },
): Promise<{ address: Address; initialOwners: Hex[] } | null> {
  const handle = (raw.response as AuthenticatorAssertionResponse).userHandle;
  const named = handle?.byteLength === 20 ? getAddress(bytesToHex(new Uint8Array(handle))) : null;
  const mera = keyOwner(owner).toLowerCase() as Hex;
  const address = named ?? (await lookup.accountOf([mera]));
  const account = await lookup.approvals(address);
  if (!account) {
    // Not deployed, its owners never changed: the key that derives its address owns it. Deployed,
    // the account says. A backup key's account cannot be told this way (its initial owners are not
    // the key): it signs in with the key that created it.
    if (named) return null;
    const owns =
      !(await getCode(client, { address })) ||
      (await readContract(client, {
        address,
        abi: gatopagoAccountAbi,
        functionName: 'isSigner',
        args: [mera],
      }));
    return owns ? { address, initialOwners: [mera] } : null;
  }
  // Before its first approval the server may not know the initial owners: the key created it.
  const initialOwners = account?.initial_owners ?? (named ? null : [mera]);
  if (!initialOwners) return null;
  const owners = await verifiedOwners(client, {
    factory: contracts.factory,
    account: address,
    initialOwners,
    approvals: account.approvals,
  }).catch(() => null);
  return owners?.some((value) => value.toLowerCase() === mera) ? { address, initialOwners } : null;
}

/**
 * How long a passkey prompt may stay open. WebAuthn ends one that nobody answers (a prompt the
 * phone never showed, say) only at its timeout, so the screen waiting for it gets an error back
 * instead of waiting forever. Two minutes leaves time to find the key.
 */
export const PASSKEY_PROMPT_MS = 120_000;

/** Whether Mera failed because the passkey or the device gives no PRF output. */
export const isPrfUnavailable = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'PRF_UNAVAILABLE';

/**
 * A WebAuthn client for Mera that also keeps the assertion of the ceremony, which `findAccount`
 * reads: its user handle, and the signature an older account's P-256 key is recovered from. A new
 * backup passkey stores `userHandle` (its account's address) so any device finds the account;
 * `attachment` asks for a physical security key.
 */
export function capturingWebAuthnClient(
  options: { userHandle?: Uint8Array; attachment?: AuthenticatorAttachment } = {},
): {
  client: WebAuthnClient;
  seen: { created?: { id: string; publicKey: Hex }; asserted?: PasskeyAssertion };
} {
  const seen: ReturnType<typeof capturingWebAuthnClient>['seen'] = {};
  const prf = (salt: Uint8Array) => ({ prf: { eval: { first: salt as Uint8Array<ArrayBuffer> } } });
  const outputs = (raw: unknown) => {
    const results = (raw as PublicKeyCredential).getClientExtensionResults().prf;
    const first = results?.results?.first;
    return {
      enabled: results?.enabled === true,
      prfOutput: first ? new Uint8Array(first as ArrayBuffer) : undefined,
    };
  };
  const rawId = (raw: unknown) => new Uint8Array((raw as PublicKeyCredential).rawId);
  return {
    seen,
    client: {
      async createCredential(request) {
        const credential = await WebAuthnP256.createCredential({
          rp: request.rp,
          user: options.userHandle
            ? { ...request.user, id: options.userHandle as Uint8Array<ArrayBuffer> }
            : request.user,
          challenge: request.challenge,
          timeout: request.timeout,
          attestation: request.attestation,
          authenticatorSelection: {
            residentKey: request.residentKey,
            requireResidentKey: true,
            userVerification: request.userVerification,
            ...(options.attachment && { authenticatorAttachment: options.attachment }),
          },
          extensions: prf(request.prfSalt),
        });
        seen.created = {
          id: credential.id,
          publicKey: PublicKey.toHex(credential.publicKey, { includePrefix: false }),
        };
        const { enabled, prfOutput } = outputs(credential.raw);
        return {
          credentialId: rawId(credential.raw),
          prfEnabled: enabled,
          ...(prfOutput ? { prfOutput } : {}),
        };
      },
      async getCredential(request) {
        const options = WebAuthnP256.getCredentialRequestOptions({
          rpId: request.rpId,
          challenge: bytesToHex(request.challenge),
          userVerification: request.userVerification,
          credentialId: request.allowCredential
            ? Base64.fromBytes(request.allowCredential.credentialId, { url: true, pad: false })
            : undefined,
          extensions: prf(request.prfSalt),
        });
        // The time limit reaches the browser, which may adjust it, and the signal ends the prompt
        // for certain when it passes.
        const assertion = await WebAuthnP256.sign(
          request.timeout === undefined
            ? options
            : ({
                publicKey: { ...options.publicKey, timeout: request.timeout },
                signal: AbortSignal.timeout(request.timeout),
              } as Parameters<typeof WebAuthnP256.sign>[0]),
        );
        seen.asserted = assertion;
        const { prfOutput } = outputs(assertion.raw);
        return { credentialId: rawId(assertion.raw), ...(prfOutput ? { prfOutput } : {}) };
      },
    },
  };
}

/**
 * Mera's recipe: a passkey's 32-byte PRF output is the entropy of a BIP-39 recovery phrase, whose
 * seed derives every key. It is fixed: changing any step changes every key derived from it. The
 * caller wipes the seed after use.
 */
export const meraSeed = (prfOutput: Uint8Array): Uint8Array =>
  mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));

/** BIP-44 path of the first Ethereum account: the key that owns a Mera account. */
const MERA_EVM_PATH = "m/44'/60'/0'/0/0";

/** The Ethereum private key of a Mera seed (`MERA_EVM_PATH`); the caller wipes it after use. */
export function meraEvmKey(seed: Uint8Array): Uint8Array {
  const node = HDKey.fromMasterSeed(seed).derive(MERA_EVM_PATH);
  if (!node.privateKey) throw new Error('MERA_DERIVATION_FAILED');
  const key = node.privateKey.slice();
  node.wipePrivateData();
  return key;
}

/**
 * The Ed25519 private key at SEP-5's path `m/44'/148'/<index>'` (SLIP-10, every level hardened) of
 * a BIP-39 `seed`: the Stellar key any SEP-5 wallet derives from the same recovery phrase.
 */
export async function stellarKeyFromSeed(seed: Uint8Array, index = 0): Promise<Uint8Array> {
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
          'raw',
          key as Uint8Array<ArrayBuffer>,
          { name: 'HMAC', hash: 'SHA-512' },
          false,
          ['sign'],
        ),
        data as Uint8Array<ArrayBuffer>,
      ),
    );
  let node = await hmac(stringToBytes('ed25519 seed'), seed);
  for (const level of [44, 148, index]) {
    // 0x00 ‖ parent key ‖ index + 2^31.
    const data = new Uint8Array(37);
    data.set(node.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, level + 0x8000_0000);
    const child = await hmac(node.subarray(32), data);
    node.fill(0);
    node = child;
  }
  const key = node.slice(0, 32);
  node.fill(0);
  return key;
}
