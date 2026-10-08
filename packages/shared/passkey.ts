import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { WebAuthnClient } from '@category-labs/mera';
import { Base64, P256, PublicKey, WebAuthnP256 } from 'ox';
import {
  bytesToHex,
  concat,
  getAddress,
  sha256,
  stringToBytes,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { walletContracts } from './networks';
import { ownersAfter, passkeyOwner } from './wallet';

/**
 * How a passkey identifies a GatoPago account, shared by the app and the merchant console so both
 * always find the same one, with one prompt: the passkey's own key, recovered from a signature, or
 * the keys Mera derives from its PRF output.
 */

/**
 * The two P-256 public keys (64-byte hex) a WebAuthn assertion signature can come from. WebAuthn
 * returns no public key on sign-in, so it is recovered and matched against an account's owners.
 */
export function recoverPasskeyPublicKeys(
  metadata: { authenticatorData: Hex; clientDataJSON: string },
  signature: { r: bigint; s: bigint },
): Hex[] {
  const payload = sha256(
    concat([metadata.authenticatorData, sha256(stringToHex(metadata.clientDataJSON))]),
  );
  return [0, 1].map((yParity) =>
    PublicKey.toHex(P256.recoverPublicKey({ payload, signature: { ...signature, yParity } }), {
      includePrefix: false,
    }),
  );
}

/** A passkey assertion, as ox's `WebAuthnP256.sign` returns it. */
export type PasskeyAssertion = Awaited<ReturnType<typeof WebAuthnP256.sign>>;

/** What the app knows of an account (`GET /app/v1/approvals/:address`). */
export interface AccountApprovals {
  readonly initial_owners: Hex[] | null;
  readonly approvals: readonly { readonly call: Hex }[];
}

/**
 * The account a passkey assertion belongs to, as one of its current passkey owners, or null.
 * `accountOf` is the address the factory derives from initial owners; `approvals` what Wallet Core
 * knows of an address, null when it is not a member's. A backup passkey carries its account's
 * address as the user handle, since its key is not among the initial owners.
 */
export async function passkeyAccount(
  { id, metadata, signature, raw }: PasskeyAssertion,
  lookup: {
    accountOf(owners: readonly Hex[]): Promise<Address>;
    approvals(address: Address): Promise<AccountApprovals | null>;
  },
): Promise<{
  credentialId: string;
  publicKey: Hex;
  address: Address;
  initialOwners: Hex[];
} | null> {
  const handle = (raw.response as AuthenticatorAssertionResponse).userHandle;
  const backupOf =
    handle?.byteLength === 20 ? getAddress(bytesToHex(new Uint8Array(handle))) : null;
  for (const publicKey of recoverPasskeyPublicKeys(metadata, signature)) {
    const owner = passkeyOwner(walletContracts.webAuthnVerifier, publicKey);
    const address = backupOf ?? (await lookup.accountOf([owner]));
    const account = await lookup.approvals(address);
    if (!account) continue;
    // Before its first approval the server only knows the address, which derives from [owner].
    const initialOwners = account.initial_owners ?? (backupOf ? [] : [owner]);
    const owners = ownersAfter(
      initialOwners,
      account.approvals.map((approval) => approval.call),
    );
    if (owners.some((value) => value.toLowerCase() === owner.toLowerCase()))
      return { credentialId: id, publicKey, address, initialOwners };
  }
  return null;
}

/** Whether Mera failed because the passkey or the device gives no PRF output. */
export const isPrfUnavailable = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'PRF_UNAVAILABLE';

/**
 * A WebAuthn client for Mera that also keeps, from the same ceremony, what GatoPago needs when the
 * passkey itself signs: a new passkey's public key, or the assertion it is recovered from. With
 * it, one prompt finds either kind of account (`passkeyAccount` when Mera finds none).
 */
export function capturingWebAuthnClient(): {
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
        // P-256 only (ox's default), so the passkey can also own the account itself.
        const credential = await WebAuthnP256.createCredential({
          rp: request.rp,
          user: request.user,
          challenge: request.challenge,
          timeout: request.timeout,
          attestation: request.attestation,
          authenticatorSelection: {
            residentKey: request.residentKey,
            requireResidentKey: true,
            userVerification: request.userVerification,
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
        const assertion = await WebAuthnP256.sign({
          rpId: request.rpId,
          challenge: bytesToHex(request.challenge),
          userVerification: request.userVerification,
          credentialId: request.allowCredential
            ? Base64.fromBytes(request.allowCredential.credentialId, { url: true, pad: false })
            : undefined,
          extensions: prf(request.prfSalt),
        });
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
export const MERA_EVM_PATH = "m/44'/60'/0'/0/0";

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
