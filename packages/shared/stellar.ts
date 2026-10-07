import {
  Account,
  Address as StellarAddress,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  bytesToHex,
  concat,
  getAddress,
  hexToBigInt,
  hexToBytes,
  hexToNumber,
  hexToString,
  isAddressEqual,
  numberToHex,
  pad,
  size,
  slice,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import type { WebAuthnAccount } from 'viem/account-abstraction';
import { FORWARD_HOOK, burnCalls, finality } from './crosschain';
import { walletContracts, type StellarNetwork, type WalletNetwork } from './networks';

/**
 * Stellar accounts mirror the EVM account: an OpenZeppelin smart account at an address derived
 * from the EVM account's address, signed by the same passkeys or by Ed25519 keys that Mera derives
 * from them, any one of them enough.
 */

/**
 * A key that signs for a Stellar account: one of its passkeys, or an Ed25519 key (`publicKey`, 32
 * bytes) that signs messages, such as a Mera signing session's.
 */
export type StellarKey =
  | WebAuthnAccount
  | {
      readonly type: 'ed25519';
      readonly publicKey: Hex;
      signMessage(message: Uint8Array): Promise<Uint8Array>;
    };

/** USDC has 7 decimals on Stellar and 6 everywhere else (CCTP burns whole 6-decimal units). */
export const toStellarUnits = (amount: bigint) => amount * 10n;
export const fromStellarUnits = (amount: bigint) => amount / 10n;

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const DEFAULT_RULE = 0;

/**
 * The Stellar account of `account`: its contract id, given by the `deployer` (the only key that
 * can create it) and the EVM address. Funds can arrive before it exists.
 */
export function stellarAccountAddress(
  network: StellarNetwork,
  deployer: string,
  account: Address,
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(stringToBytes(network.passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: StellarAddress.fromString(deployer).toScAddress(),
          salt: salt(account),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXdr()));
}

const salt = (account: Address) => hash(hexToBytes(account));

/**
 * The Stellar signer of an EVM account owner (verifier ‖ x ‖ y), or null when it is not a GatoPago
 * passkey. Stellar's WebAuthn verifier takes the uncompressed P-256 key.
 */
export function stellarSigner(network: StellarNetwork, owner: Hex): xdr.ScVal | null {
  if (size(owner) !== 84 || !isAddressEqual(slice(owner, 0, 20), walletContracts.webAuthnVerifier))
    return null;
  return passkeySigner(network, slice(owner, 20));
}

/** External signer of a P-256 key (64-byte x ‖ y, or 0x04-prefixed). */
function passkeySigner(network: StellarNetwork, publicKey: Hex): xdr.ScVal {
  const key = size(publicKey) === 65 ? publicKey : concat(['0x04', publicKey]);
  if (size(key) !== 65) throw new Error('INVALID_PASSKEY_PUBLIC_KEY');
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    new StellarAddress(network.account.webAuthnVerifier).toScVal(),
    xdr.ScVal.scvBytes(hexToBytes(key)),
  ]);
}

/** External signer of an Ed25519 public key (32 bytes), checked by the network's verifier. */
export function ed25519Signer(network: StellarNetwork, publicKey: Hex): xdr.ScVal {
  if (size(publicKey) !== 32) throw new Error('INVALID_ED25519_PUBLIC_KEY');
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    new StellarAddress(network.account.ed25519Verifier).toScVal(),
    xdr.ScVal.scvBytes(hexToBytes(publicKey)),
  ]);
}

/** The Stellar signers of an EVM account: its passkey `owners` and its Ed25519 `keys`. */
function accountSigners(network: StellarNetwork, owners: readonly Hex[], keys: readonly Hex[]) {
  const signers = [
    ...owners.map((owner) => stellarSigner(network, owner)).filter((signer) => signer !== null),
    ...keys.map((key) => ed25519Signer(network, key)),
  ];
  if (signers.length === 0) throw new Error('STELLAR_ACCOUNT_WITHOUT_SIGNERS');
  return signers;
}

/**
 * Creates the Stellar account of `account` with the EVM account's current passkey `owners`
 * (`ownersAfter`) and approved Ed25519 `keys` (`stellarKeyApproval`), any one of them able to
 * sign. Only `deployer` can send it.
 */
export function deployAccountOperation(
  network: StellarNetwork,
  deployer: string,
  account: Address,
  owners: readonly Hex[],
  keys: readonly Hex[] = [],
): xdr.Operation {
  const signers = accountSigners(network, owners, keys);
  return Operation.createCustomContract({
    address: new StellarAddress(deployer),
    wasmHash: hexToBytes(`0x${network.account.wasmHash}`),
    salt: salt(account),
    constructorArgs: [
      xdr.ScVal.scvVec(signers),
      map([[new StellarAddress(network.account.thresholdPolicy).toScVal(), threshold(1)]]),
    ],
  });
}

const threshold = (value: number) =>
  map([[xdr.ScVal.scvSymbol('threshold'), xdr.ScVal.scvU32(value)]]);
const map = (entries: [xdr.ScVal, xdr.ScVal][]) =>
  xdr.ScVal.scvMap(entries.map(([key, val]) => new xdr.ScMapEntry({ key, val })));
const call = (contract: string, method: string, args: xdr.ScVal[]) =>
  Operation.invokeContractFunction({ contract, function: method, args });
const address = (value: string) => new StellarAddress(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const bytes = (value: Hex) => xdr.ScVal.scvBytes(hexToBytes(value));

/** Adds an EVM owner the account approved (`addOwners`) as a Stellar signer. */
export function addSignerOperation(network: StellarNetwork, account: string, owner: Hex) {
  const signer = stellarSigner(network, owner);
  if (!signer) throw new Error('NOT_A_PASSKEY_OWNER');
  return call(account, 'add_signer', [xdr.ScVal.scvU32(DEFAULT_RULE), signer]);
}

/**
 * The calls that make the Stellar account's signers the passkeys among the EVM account's `owners`
 * (`ownersAfter`) and its Ed25519 `keys`: keys approved after it was created are added, removed
 * ones taken out. Additions go first, so the account always keeps a signer. Each call is signed on
 * its own.
 */
export async function signerChangeOperations(
  server: rpc.Server,
  network: StellarNetwork,
  account: string,
  owners: readonly Hex[],
  keys: readonly Hex[] = [],
): Promise<xdr.Operation[]> {
  const wanted = accountSigners(network, owners, keys).map((signer) => signer.toXdr('base64'));
  const rule = await simulate(
    server,
    network,
    call(account, 'get_context_rule', [xdr.ScVal.scvU32(DEFAULT_RULE)]),
  );
  // ContextRule { signers: Vec<Signer>, signer_ids: Vec<u32>, … }
  const field = (name: string) => {
    const value =
      rule.type === 'scvMap'
        ? rule.map?.find(({ key }) => key.type === 'scvSymbol' && key.value === name)?.val
        : undefined;
    if (value?.type !== 'scvVec' || !value.vec) throw new Error('STELLAR_READ_FAILED');
    return value.vec;
  };
  const current = field('signers').map((signer) => signer.toXdr('base64'));
  const ids = field('signer_ids').map((id) => (id.type === 'scvU32' ? id.u32 : -1));
  return [
    ...wanted
      .filter((signer) => !current.includes(signer))
      .map((signer) =>
        call(account, 'add_signer', [
          xdr.ScVal.scvU32(DEFAULT_RULE),
          xdr.ScVal.fromXdr(signer, 'base64'),
        ]),
      ),
    ...current.flatMap((signer, i) =>
      wanted.includes(signer) ? [] : [removeSignerOperation(account, ids[i])],
    ),
  ];
}

/** Removes the signer `signerId` (the account's `get_signer_id`). */
export function removeSignerOperation(account: string, signerId: number) {
  return call(account, 'remove_signer', [
    xdr.ScVal.scvU32(DEFAULT_RULE),
    xdr.ScVal.scvU32(signerId),
  ]);
}

/** Sends `amount` (7 decimals) of USDC to any Stellar address. */
export function transferOperation(
  network: StellarNetwork,
  from: string,
  to: string,
  amount: bigint,
) {
  return call(network.usdc, 'transfer', [address(from), address(to), i128(amount)]);
}

/** How long a burn allowance lasts, in ledgers: about 174 days, within the network's longest. */
export const BURN_APPROVAL_LEDGERS = 3_000_000;

/**
 * Lets Circle's TokenMessengerMinter take USDC for burns until `expirationLedger` (the latest
 * ledger plus `BURN_APPROVAL_LEDGERS`). Circle issues this USDC already; with a long allowance
 * each crossing needs one signature, not two.
 */
export function approveBurnsOperation(
  network: StellarNetwork,
  account: string,
  expirationLedger: number,
) {
  return call(network.usdc, 'approve', [
    address(account),
    address(network.cctp.tokenMessengerMinter),
    i128(2n ** 127n - 1n),
    xdr.ScVal.scvU32(expirationLedger),
  ]);
}

/**
 * Burns `amount` (7 decimals; the seventh stays in the account) so that `recipient` receives it on
 * `to` minus at most `maxFee` (6 decimals, `crosschainFee`); Circle's Forwarding Service mints.
 */
export function crosschainOperation(
  network: StellarNetwork,
  parameters: {
    account: string;
    to: WalletNetwork;
    amount: bigint;
    recipient: Address;
    maxFee: bigint;
  },
) {
  const { account, to, amount, recipient, maxFee } = parameters;
  if (toStellarUnits(maxFee) >= amount) throw new Error('CCTP_AMOUNT_BELOW_FEE');
  return call(network.cctp.tokenMessengerMinter, 'deposit_for_burn_with_hook', [
    address(account),
    i128(amount),
    xdr.ScVal.scvU32(to.cctp.domain),
    bytes(pad(recipient)),
    address(network.usdc),
    bytes(pad('0x')),
    i128(toStellarUnits(maxFee)),
    xdr.ScVal.scvU32(finality(network)),
    bytes(FORWARD_HOOK),
  ]);
}

/**
 * EVM calls that burn `amount` USDC on `from` toward the Stellar address `recipient`. Circle mints
 * to its CctpForwarder, which pays `recipient` once someone relays (`mintAndForwardOperation`).
 */
export function crosschainToStellarCalls(parameters: {
  from: WalletNetwork;
  to: StellarNetwork;
  amount: bigint;
  recipient: string;
  maxFee: bigint;
}) {
  const { from, to, amount, recipient, maxFee } = parameters;
  const forwarder = bytesToHex(StrKey.decodeContract(to.cctp.forwarder));
  return burnCalls(from, {
    domain: to.cctp.domain,
    mintRecipient: forwarder,
    destinationCaller: forwarder,
    hookData: forwardRecipientHook(recipient),
    amount,
    maxFee,
  });
}

/** CctpForwarder hook: 24 zero bytes, version 0, recipient length, recipient strkey (UTF-8). */
export function forwardRecipientHook(recipient: string): Hex {
  if (!isStellarAddress(recipient)) throw new Error('INVALID_STELLAR_ADDRESS');
  const strkey = stringToBytes(recipient);
  return concat([
    pad('0x', { size: 24 }),
    numberToHex(0, { size: 4 }),
    numberToHex(strkey.length, { size: 4 }),
    bytesToHex(strkey),
  ]);
}

/** Mints a CCTP message on Stellar and pays its recipient; anyone can send it. */
export function mintAndForwardOperation(network: StellarNetwork, message: Hex, attestation: Hex) {
  return call(network.cctp.forwarder, 'mint_and_forward', [bytes(message), bytes(attestation)]);
}

/**
 * Simulates `operation` with `source` paying (the sponsor) and returns what the account must sign.
 * The source needs no sequence here: only the sponsor sends.
 */
export async function prepareStellarCall(
  server: rpc.Server,
  network: StellarNetwork,
  source: string,
  operation: xdr.Operation,
) {
  const transaction = new TransactionBuilder(new Account(source, '0'), {
    fee: '0',
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(0)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation))
    throw new Error(`STELLAR_SIMULATION_FAILED: ${simulation.error}`);
  const body = operation.body;
  if (body.type !== 'invokeHostFunction') throw new Error('NOT_A_CONTRACT_CALL');
  return {
    func: body.invokeHostFunctionOp.hostFunction,
    auth: simulation.result?.auth ?? [],
    latestLedger: simulation.latestLedger,
  };
}

/**
 * Signs the account's authorization entries with one of its keys, valid until `validUntil`. Each
 * entry is signed over the smart account's auth digest, which binds the default rule: a passkey
 * proves it with its WebAuthn data, an Ed25519 key with its 64-byte signature of the digest.
 */
export function signStellarAuth(
  network: StellarNetwork,
  entries: readonly xdr.SorobanAuthorizationEntry[],
  parameters: { owner: StellarKey; validUntil: number },
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const { owner, validUntil } = parameters;
  const signer =
    owner.type === 'ed25519'
      ? ed25519Signer(network, owner.publicKey)
      : passkeySigner(network, owner.publicKey);
  return Promise.all(
    entries.map((entry) => {
      // One rule id per authorized call in the entry: the account checks each against the rule.
      const rules = xdr.ScVal.scvVec(
        Array.from({ length: invocations(entry.rootInvocation) }, () =>
          xdr.ScVal.scvU32(DEFAULT_RULE),
        ),
      );
      return authorizeEntry(
        entry,
        async (_preimage, payload) => {
          const digest = hash(concat([payload, rules.toXdr()]));
          const proof =
            owner.type === 'ed25519'
              ? await owner.signMessage(digest)
              : (await passkeyProof(owner, digest)).toXdr();
          return {
            signatureScVal: map([
              [xdr.ScVal.scvSymbol('context_rule_ids'), rules],
              [xdr.ScVal.scvSymbol('signers'), map([[signer, xdr.ScVal.scvBytes(proof)]])],
            ]),
          };
        },
        validUntil,
        network.passphrase,
      );
    }),
  );
}

/** WebAuthnSigData of a passkey's signature of `digest`, with `s` normalized to the low half. */
async function passkeyProof(owner: WebAuthnAccount, digest: Uint8Array) {
  const { signature, webauthn } = await owner.sign({ hash: bytesToHex(digest) });
  let s = hexToBigInt(slice(signature, 32, 64));
  if (s > P256_N / 2n) s = P256_N - s;
  return map([
    [xdr.ScVal.scvSymbol('authenticator_data'), bytes(webauthn.authenticatorData)],
    [
      xdr.ScVal.scvSymbol('client_data'),
      xdr.ScVal.scvBytes(stringToBytes(webauthn.clientDataJSON)),
    ],
    [
      xdr.ScVal.scvSymbol('signature'),
      bytes(concat([slice(signature, 0, 32), numberToHex(s, { size: 32 })])),
    ],
  ]);
}

const invocations = (invocation: xdr.SorobanAuthorizedInvocation): number =>
  1 + invocation.subInvocations.reduce((total, sub) => total + invocations(sub), 0);

/**
 * Sends `operation` from the sponsor `keypair`, which pays its fee (at most `maxFee` stroops, when
 * given). Contract calls carry their signed authorization (`signedCallOperation`). Resolves once the
 * network applied it.
 */
export async function sendStellarOperation(
  server: rpc.Server,
  network: StellarNetwork,
  keypair: Keypair,
  operation: xdr.Operation,
  options: { maxFee?: bigint } = {},
) {
  const transaction = new TransactionBuilder(await server.getAccount(keypair.publicKey()), {
    fee: '100',
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(transaction);
  if (options.maxFee !== undefined && BigInt(prepared.fee) > options.maxFee)
    throw new Error('STELLAR_FEE_TOO_HIGH');
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== 'PENDING') throw new Error(`STELLAR_SEND_FAILED: ${sent.status}`);
  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  // Not seen yet is not failed: it may still land until its time bound.
  if (result.status === 'NOT_FOUND') throw new Error(`STELLAR_TRANSACTION_PENDING: ${sent.hash}`);
  if (result.status !== 'SUCCESS') throw new Error(`STELLAR_TRANSACTION_FAILED: ${sent.hash}`);
  return { hash: sent.hash, ledger: result.ledger, returnValue: result.returnValue };
}

/** A contract call with its signed authorization, ready for `sendStellarOperation`. */
export const signedCallOperation = (
  func: xdr.HostFunction,
  auth: readonly xdr.SorobanAuthorizationEntry[],
) => Operation.invokeHostFunction({ func, auth: [...auth] });

/**
 * How long a signed call stays valid, in ledgers of about five seconds: five minutes, like an EVM
 * sponsorship. Past it the call can no longer land, so an unanswered one is settled.
 */
const SIGNATURE_LEDGERS = 60;

/**
 * Prepares `operation` with the `sponsor` paying and signs it with one of the account's passkeys,
 * as base64 XDR for Wallet Core to send (`POST /app/v1/stellar/submit`). Once the call lands, its
 * `nonces` are used (`stellarNonceUsed`) and Wallet Core remembers them: how a lost answer is found
 * out. Unused at `validUntil`, it never landed.
 */
export async function signedStellarCall(
  server: rpc.Server,
  network: StellarNetwork,
  parameters: { sponsor: string; operation: xdr.Operation; owner: StellarKey },
) {
  const call = await prepareStellarCall(server, network, parameters.sponsor, parameters.operation);
  const validUntil = call.latestLedger + SIGNATURE_LEDGERS;
  const auth = await signStellarAuth(network, call.auth, { owner: parameters.owner, validUntil });
  return {
    func: call.func.toXdr('base64'),
    auth: auth.map((entry) => entry.toXdr('base64')),
    nonces: auth.flatMap(({ credentials }) =>
      credentials.type === 'sorobanCredentialsSourceAccount'
        ? []
        : [
            (credentials.type === 'sorobanCredentialsAddressWithDelegates'
              ? credentials.value.addressCredentials
              : credentials.value
            ).nonce.toString(),
          ],
    ),
    validUntil,
  };
}

/**
 * Whether `account` used the authorization `nonce`, that is, whether the call it signed landed.
 * The network remembers it until the signature's `validUntil` ledger.
 */
export async function stellarNonceUsed(server: rpc.Server, account: string, nonce: string) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new StellarAddress(account).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: BigInt(nonce) })),
      durability: xdr.ContractDataDurability.temporary,
    }),
  );
  return (await server.getLedgerEntries(key)).entries.length > 0;
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

/**
 * What an owner key of the EVM account signs (EIP-191) so that the Ed25519 `publicKey` also signs
 * for its Stellar account, until `expiresAt` (Unix seconds): Wallet Core accepts it only before then
 * and only while the signer owns the account, so an old approval cannot bring a key back.
 */
export const stellarKeyApproval = (
  network: StellarNetwork,
  account: Address,
  publicKey: Hex,
  expiresAt: number,
) =>
  [
    'GatoPago: add this key as a signer of my Stellar account.',
    '',
    `Account: ${getAddress(account)}`,
    `Key: ${publicKey.toLowerCase()}`,
    `Network: ${network.passphrase}`,
    `Expires: ${new Date(expiresAt * 1000).toISOString()}`,
  ].join('\n');

/** A Stellar RPC client: `rpcUrl` when configured, else the network's public one. */
export const stellarServer = (network: StellarNetwork, rpcUrl?: string) =>
  new rpc.Server(rpcUrl ?? network.rpcUrl);

/** Whether USDC can be sent to `value` on Stellar: an account (G…) or a contract (C…). */
export const isStellarAddress = (value: string) =>
  StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);

/** Any account will do to simulate a read. */
const SIMULATION_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** USDC balance of a Stellar address, in 7 decimals. */
export const stellarUsdcBalance = (server: rpc.Server, network: StellarNetwork, owner: string) =>
  read<bigint>(server, network, call(network.usdc, 'balance', [address(owner)]));

/** USDC that Circle's minter may still burn from `account` (`approveBurnsOperation`). */
export const stellarBurnAllowance = (
  server: rpc.Server,
  network: StellarNetwork,
  account: string,
) =>
  read<bigint>(
    server,
    network,
    call(network.usdc, 'allowance', [address(account), address(network.cctp.tokenMessengerMinter)]),
  );

const read = async <T>(server: rpc.Server, network: StellarNetwork, operation: xdr.Operation) =>
  scValToNative(await simulate(server, network, operation)) as T;

async function simulate(server: rpc.Server, network: StellarNetwork, operation: xdr.Operation) {
  const transaction = new TransactionBuilder(new Account(SIMULATION_SOURCE, '0'), {
    fee: '0',
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(0)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result)
    throw new Error('STELLAR_READ_FAILED');
  return simulation.result.retval;
}

/** Whether the Stellar account (or any contract) exists yet. */
export async function stellarAccountExists(server: rpc.Server, account: string) {
  const instance = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new StellarAddress(account).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  return (await server.getLedgerEntries(instance)).entries.length > 0;
}

/**
 * The parts of a CCTP V2 burn message a relayer checks: its destination, who burned it, how much,
 * and the Stellar recipient its CctpForwarder hook names (null without one).
 */
export function burnMessage(message: Hex) {
  const word = (offset: number) => slice(message, offset, offset + 32);
  const hook = size(message) > 376 ? slice(message, 376) : '0x';
  const recipientLength = size(hook) >= 32 ? hexToNumber(slice(hook, 28, 32)) : 0;
  return {
    destinationDomain: hexToNumber(slice(message, 8, 12)),
    amount: hexToBigInt(word(216)),
    sender: getAddress(slice(word(248), 12)),
    recipient:
      recipientLength > 0 && size(hook) >= 32 + recipientLength
        ? hexToString(slice(hook, 32, 32 + recipientLength))
        : null,
  };
}
