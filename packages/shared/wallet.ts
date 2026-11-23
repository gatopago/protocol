import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  hexToBigInt,
  isErc6492Signature,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseErc6492Signature,
  size,
  slice,
  toFunctionSelector,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
  zeroHash,
} from 'viem';
import {
  entryPoint09Abi,
  entryPoint09Address,
  getUserOperationHash,
  toSmartAccount,
  type SmartAccount,
  type SmartAccountImplementation,
  type UserOperation,
  type WebAuthnAccount,
} from 'viem/account-abstraction';
import { getCode, readContract, verifyHash } from 'viem/actions';
import {
  hashMessage,
  hashTypedData as hashNestedTypedData,
  wrapTypedDataSignature,
} from 'viem/experimental/erc7739';

/** Contracts in protocol/contracts/src/wallet. */
export const gatopagoAccountAbi = parseAbi([
  'function execute(bytes32 mode, bytes executionData) payable',
  'function addOwners(bytes[] owners)',
  'function removeOwners(bytes[] owners)',
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
  'function applyApproval(uint256 sequence, bytes call)',
  'function approvalSequence() view returns (uint256)',
  'function applyChange(uint256 sequence, bytes call)',
  'function cancelChange(bytes32 id)',
  'function changeReadyAt(bytes32 id) view returns (uint48)',
  'event ChangeScheduled(bytes32 indexed id, uint256 sequence, bytes call, uint48 readyAt)',
  'event ChangeApplied(bytes32 indexed id)',
  'event ChangeCanceled(bytes32 indexed id)',
  'function isSigner(bytes signer) view returns (bool)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
  'function getSignerCount() view returns (uint256)',
]);
export const gatopagoAccountFactoryAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 salt) returns (address)',
  'function getAddress(bytes[] owners, uint256 salt) view returns (address)',
]);

export interface WalletContracts {
  readonly factory: Address;
  readonly webAuthnVerifier: Address;
  readonly paymaster: Address;
}

/**
 * Nonce key of the account's approval channel: `applyApproval(sequence, call)` for one owner change
 * or upgrade, signed without the chain id so the same approval applies on every network
 * (see GatoPagoAccount.sol). The EntryPoint nonce is not signed: a failed attempt can be resent.
 */
export const REPLAYABLE_NONCE_KEY = 0x4761746f5061676fn;

/**
 * How long a sponsorship signed by Wallet Core lasts: after it, an operation that was not included
 * can no longer be, so a client may consider it dropped.
 */
export const SPONSORSHIP_SECONDS = 300;

/** ERC-7579 batch mode: callType 0x01, default exec type, no selector or payload. */
const BATCH_MODE = pad('0x01', { dir: 'right', size: 32 });
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** ERC-7913 signer for a passkey: verifier ‖ x ‖ y. Accepts 64-byte or 0x04-prefixed keys. */
export function passkeyOwner(webAuthnVerifier: Address, publicKey: Hex): Hex {
  const key = size(publicKey) === 65 ? slice(publicKey, 1) : publicKey;
  if (size(key) !== 64) throw new Error('INVALID_PASSKEY_PUBLIC_KEY');
  return concat([webAuthnVerifier, key]);
}

/** `abi.encode([owner], [signature])`, the format OpenZeppelin's MultiSignerERC7913 expects. */
const ownerSignature = (owner: Hex, signature: Hex) =>
  encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[owner], [signature]]);

/** A passkey owner's signature: `ownerSignature` over its WebAuthnAuth. */
function encodePasskeySignature(
  owner: Hex,
  signature: Hex,
  webauthn: {
    authenticatorData: Hex;
    clientDataJSON: string;
    challengeIndex?: number;
    typeIndex?: number;
  },
): Hex {
  const r = slice(signature, 0, 32);
  let s = hexToBigInt(slice(signature, 32, 64));
  if (s > P256_N / 2n) s = P256_N - s;
  const auth = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'string' },
    ],
    [
      r,
      numberToHex(s, { size: 32 }),
      BigInt(webauthn.challengeIndex ?? 23),
      BigInt(webauthn.typeIndex ?? 1),
      webauthn.authenticatorData,
      webauthn.clientDataJSON,
    ],
  );
  return ownerSignature(owner, auth);
}

/** Chain-independent hash an owner signs to approve `call` as approval number `sequence`. */
function approvalHash(account: Address, sequence: bigint, call: Hex): Hex {
  return hashTypedData({
    domain: { name: 'GatoPagoAccount', version: '1', verifyingContract: account },
    types: {
      Approval: [
        { name: 'sequence', type: 'uint256' },
        { name: 'call', type: 'bytes' },
      ],
    },
    primaryType: 'Approval',
    message: { sequence, call },
  });
}

/** UserOperation callData that applies an approval; send it with a `REPLAYABLE_NONCE_KEY` nonce. */
export function encodeApplyApproval(sequence: bigint, call: Hex): Hex {
  return encodeFunctionData({
    abi: gatopagoAccountAbi,
    functionName: 'applyApproval',
    args: [sequence, call],
  });
}

const isReplayableNonce = (nonce: bigint) => nonce >> 64n === REPLAYABLE_NONCE_KEY;

/**
 * Id of the change approval number `sequence` schedules (removing owners or upgrading wait two
 * days), as the account computes it.
 */
export const changeId = (sequence: bigint, call: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [sequence, call]));

/**
 * Cancels a scheduled change: one call of a normal operation, signed by any owner and bound to its
 * network, so a cancellation cannot be raced like an approval.
 */
export const cancelChangeCall = (account: Address, id: Hex) => ({
  to: account,
  data: encodeFunctionData({ abi: gatopagoAccountAbi, functionName: 'cancelChange', args: [id] }),
});

/** Applies a scheduled change once due: one call of a normal operation (anyone may send it). */
export const applyChangeCall = (account: Address, sequence: bigint, call: Hex) => ({
  to: account,
  data: encodeFunctionData({
    abi: gatopagoAccountAbi,
    functionName: 'applyChange',
    args: [sequence, call],
  }),
});

const erc7913VerifierAbi = parseAbi([
  'function verify(bytes key, bytes32 hash, bytes signature) view returns (bytes4)',
]);
const ERC7913_VALID = toFunctionSelector('verify(bytes,bytes32,bytes)');

/**
 * The owners approvals give an account where it is not deployed yet: its initial owners plus every
 * approved addition. Removals are left out: each waits two days on each network, where it may still
 * be cancelled, so only a deployed account says whether one applied (`accountOwners`).
 */
export function approvedOwners(initialOwners: readonly Hex[], calls: readonly Hex[]): Hex[] {
  const owners = new Set(initialOwners.map((owner) => owner.toLowerCase() as Hex));
  for (const call of calls) {
    const { functionName, args } = decodeFunctionData({ abi: gatopagoAccountAbi, data: call });
    if (functionName === 'addOwners')
      for (const owner of args[0] as readonly Hex[]) owners.add(owner.toLowerCase() as Hex);
  }
  return [...owners];
}

/**
 * The owners `account` has on `client`'s network once it applies the approvals in `calls` it is
 * still missing: read from the account where it is deployed, plus the additions among those
 * approvals; before it is deployed, its initial owners plus every approved addition.
 */
export async function accountOwners(
  client: Client,
  parameters: { account: Address; initialOwners: readonly Hex[]; calls: readonly Hex[] },
): Promise<Hex[]> {
  const { account, initialOwners, calls } = parameters;
  if (!(await getCode(client, { address: account }))) return approvedOwners(initialOwners, calls);
  const contract = { address: account, abi: gatopagoAccountAbi } as const;
  const [count, applied] = await Promise.all([
    readContract(client, { ...contract, functionName: 'getSignerCount' }),
    readContract(client, { ...contract, functionName: 'approvalSequence' }),
  ]);
  const owners = await readContract(client, {
    address: account,
    abi: gatopagoAccountAbi,
    functionName: 'getSigners',
    args: [0n, count],
  });
  return approvedOwners(owners, calls.slice(Number(applied)));
}

/**
 * Owners once one approved owner change applies, refusing what the account would revert
 * (OpenZeppelin's MultiSignerERC7913): an existing or malformed owner, a missing one, or no owner
 * left. Upgrades are not approved through here.
 */
function nextOwners(owners: readonly Hex[], call: Hex): Hex[] {
  const { functionName, args } = decodeFunctionData({ abi: gatopagoAccountAbi, data: call });
  const next = new Set(owners.map((owner) => owner.toLowerCase() as Hex));
  if (functionName !== 'addOwners' && functionName !== 'removeOwners')
    throw new Error('APPROVAL_NOT_ALLOWED');
  const changed = args[0] as readonly Hex[];
  if (changed.length === 0) throw new Error('APPROVAL_EMPTY');
  for (const owner of changed.map((value) => value.toLowerCase() as Hex)) {
    if (functionName === 'addOwners') {
      if (size(owner) < 20) throw new Error('OWNER_INVALID');
      if (next.has(owner)) throw new Error('OWNER_EXISTS');
      next.add(owner);
    } else if (!next.delete(owner)) throw new Error('OWNER_NOT_FOUND');
  }
  if (next.size === 0) throw new Error('LAST_OWNER');
  return [...next];
}

/** The account's EIP-712 domain, which its ERC-7739 signatures are bound to. */
const accountDomain = (chainId: number, account: Address) =>
  ({
    name: 'GatoPagoAccount',
    version: '1',
    chainId,
    verifyingContract: account,
    salt: zeroHash,
  }) as const;

/**
 * The owner among `owners` that signed `message` for `account` as the account signs messages
 * (ERC-1271 in the ERC-7739 format, wrapped in ERC-6492 while it is not deployed), or null. It is
 * checked against the owners given, not against a network's state, which may lag behind a removal.
 */
export async function messageSigner(
  client: Client,
  parameters: { account: Address; owners: readonly Hex[]; message: string; signature: Hex },
): Promise<Hex | null> {
  const { account, owners, message, signature } = parameters;
  if (!client.chain) throw new Error('CHAIN_REQUIRED');
  return signingOwner(client, {
    owners,
    hash: hashMessage({ message, verifierDomain: accountDomain(client.chain.id, account) }),
    signature: isErc6492Signature(signature)
      ? parseErc6492Signature(signature).signature
      : signature,
  });
}

/**
 * The owner that signed `hash` for the account, in the account's signature format
 * (`abi.encode(bytes[] signers, bytes[] signatures)` with one signer), if it is among `owners` and the
 * signature is valid as the account checks it onchain (OpenZeppelin's `SignatureChecker`): an owner
 * of 20 bytes is a key (a Mera key), verified by ECDSA or ERC-1271; a longer one is
 * `verifier || key`, verified by its ERC-7913 verifier. Null otherwise.
 */
async function signingOwner(
  client: Client,
  parameters: { owners: readonly Hex[]; hash: Hex; signature: Hex },
): Promise<Hex | null> {
  const { owners, hash, signature } = parameters;
  try {
    const [signers, signatures] = decodeAbiParameters(
      [{ type: 'bytes[]' }, { type: 'bytes[]' }],
      signature,
    );
    const owner = signers[0]?.toLowerCase() as Hex | undefined;
    if (signers.length !== 1 || !owner || !owners.some((value) => value.toLowerCase() === owner))
      return null;
    const valid =
      size(owner) === 20
        ? await verifyHash(client, { address: owner, hash, signature: signatures[0] })
        : (await readContract(client, {
            address: slice(owner, 0, 20),
            abi: erc7913VerifierAbi,
            functionName: 'verify',
            args: [slice(owner, 20), hash, signatures[0]],
          })) === ERC7913_VALID;
    return valid ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Whether `signature` is approval number `sequence` of `account`, for a change the account can
 * apply, signed by one of `owners` as the account checks it onchain (`signingOwner`). `owners` are
 * the ones the account has where the approval is checked (`accountOwners`). Lets a server store
 * approvals for other networks without trusting the client.
 */
export async function verifyApproval(
  client: Client,
  parameters: {
    account: Address;
    owners: readonly Hex[];
    sequence: number;
    call: Hex;
    signature: Hex;
  },
): Promise<Hex | null> {
  const { account, owners, sequence, call, signature } = parameters;
  try {
    // The change itself must be one the account can apply, or it would block the ones after it.
    nextOwners(owners, call);
  } catch {
    return null;
  }
  const hash = approvalHash(account, BigInt(sequence), call);
  return signingOwner(client, { owners, hash, signature });
}

/**
 * The owners of `account` now (`accountOwners`), its history checked without trusting whoever
 * handed it over: the address must be the factory's for `initialOwners`, and each approval must be
 * the next one in order, signed by an owner it approved. Throws `APPROVALS_INVALID` when any of it
 * does not hold. A history cut short cannot be told from a complete one here: the caller compares
 * its length with the newest it knows (the account's own count onchain).
 */
export async function verifiedOwners(
  client: Client,
  parameters: {
    factory: Address;
    account: Address;
    initialOwners: readonly Hex[];
    approvals: readonly { sequence: number; call: Hex; signature: Hex }[];
  },
): Promise<Hex[]> {
  const { factory, account, initialOwners, approvals } = parameters;
  const derived = await readContract(client, {
    address: factory,
    abi: gatopagoAccountFactoryAbi,
    functionName: 'getAddress',
    args: [initialOwners, 0n],
  });
  if (derived.toLowerCase() !== account.toLowerCase()) throw new Error('APPROVALS_INVALID');
  const calls: Hex[] = [];
  for (const [index, approval] of approvals.entries()) {
    const signer =
      approval.sequence === index
        ? await verifyApproval(client, {
            account,
            owners: approvedOwners(initialOwners, calls),
            sequence: index,
            call: approval.call,
            signature: approval.signature,
          })
        : null;
    if (!signer) throw new Error('APPROVALS_INVALID');
    calls.push(approval.call);
  }
  return accountOwners(client, { account, initialOwners, calls });
}

export function encodeCalls(calls: readonly { to: Address; value?: bigint; data?: Hex }[]): Hex {
  const executionData = encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    [
      calls.map((call) => ({
        target: call.to,
        value: call.value ?? 0n,
        callData: call.data ?? '0x',
      })),
    ],
  );
  return encodeFunctionData({
    abi: gatopagoAccountAbi,
    functionName: 'execute',
    args: [BATCH_MODE, executionData],
  });
}

export type GatoPagoAccount = SmartAccount<
  SmartAccountImplementation<
    typeof entryPoint09Abi,
    '0.9',
    {
      owner: WebAuthnAccount | LocalAccount;
      initialOwners: readonly Hex[];
      /** The owner's signature over `hash` in the account's signature format. */
      signHash(hash: Hex): Promise<Hex>;
    }
  >
>;

/**
 * Owner approval of `call` (e.g. `addOwners`) as the account's approval number `sequence`. Store it
 * with the sequence and call: applying the same approvals in order on each network keeps owners in
 * sync, including networks where the account is only deployed later.
 */
export function signApproval(account: GatoPagoAccount, sequence: bigint, call: Hex): Promise<Hex> {
  return account.signHash(approvalHash(account.address, sequence, call));
}

/**
 * ERC-7913 signer for a key the account verifies with ECDSA: its address. A passkey account
 * derived with Mera (a key from the passkey's PRF output) owns the account this way.
 */
export const keyOwner = (address: Address): Hex => address.toLowerCase() as Hex;

/**
 * viem smart account for a GatoPago account signed by `owner`: a passkey (WebAuthn, signing on
 * the device) or a local key that signs digests (such as a Mera signing session). The address
 * derives from the account's initial owners, so a backup key must pass the original
 * `initialOwners`.
 */
export async function toGatoPagoAccount(parameters: {
  client: Client<Transport, Chain, JsonRpcAccount | LocalAccount | undefined>;
  owner: WebAuthnAccount | LocalAccount;
  contracts: Pick<WalletContracts, 'factory' | 'webAuthnVerifier'>;
  initialOwners?: readonly Hex[];
  salt?: bigint;
}): Promise<GatoPagoAccount> {
  const { client, owner, contracts, salt = 0n } = parameters;
  const signer =
    owner.type === 'webAuthn'
      ? passkeyOwner(contracts.webAuthnVerifier, owner.publicKey)
      : keyOwner(owner.address);
  const initialOwners = parameters.initialOwners ?? [signer];
  const factoryData = encodeFunctionData({
    abi: gatopagoAccountFactoryAbi,
    functionName: 'createAccount',
    args: [initialOwners, salt],
  });
  const address = await readContract(client, {
    address: contracts.factory,
    abi: gatopagoAccountFactoryAbi,
    functionName: 'getAddress',
    args: [initialOwners, salt],
  });
  const entryPoint = {
    abi: entryPoint09Abi,
    address: entryPoint09Address,
    version: '0.9',
  } as const;
  const verifierDomain = accountDomain(client.chain.id, address);
  async function signHash(hash: Hex) {
    if (owner.type === 'local') {
      if (!owner.sign) throw new Error('OWNER_CANNOT_SIGN_DIGESTS');
      return ownerSignature(signer, await owner.sign({ hash }));
    }
    const { signature, webauthn } = await owner.sign({ hash });
    return encodePasskeySignature(signer, signature, {
      ...webauthn,
      clientDataJSON:
        typeof webauthn.clientDataJSON === 'string'
          ? webauthn.clientDataJSON
          : new TextDecoder().decode(webauthn.clientDataJSON),
    });
  }

  return toSmartAccount({
    client,
    entryPoint,
    extend: { owner, initialOwners, signHash },
    async getAddress() {
      return address;
    },
    async getFactoryArgs() {
      return { factory: contracts.factory, factoryData };
    },
    async encodeCalls(calls) {
      return encodeCalls(calls);
    },
    async getStubSignature() {
      if (owner.type === 'local') return ownerSignature(signer, `0x${'11'.repeat(64)}1b`);
      return encodePasskeySignature(signer, `0x${'11'.repeat(64)}`, {
        authenticatorData: `0x${'49'.repeat(37)}`,
        clientDataJSON: `{"type":"webauthn.get","challenge":"${'A'.repeat(43)}","origin":"https://gatopago.com","crossOrigin":false}`,
      });
    },
    // ERC-1271 signatures in the ERC-7739 format OpenZeppelin's account validates; viem wraps them in
    // ERC-6492 while the account is not deployed, so they verify before the first operation too.
    async signMessage({ message }) {
      return signHash(hashMessage({ message, verifierDomain }));
    },
    async signTypedData(typedData) {
      const signature = await signHash(
        hashNestedTypedData({ ...typedData, verifierDomain } as never),
      );
      return wrapTypedDataSignature({ ...typedData, signature } as never);
    },
    async signUserOperation(userOperation) {
      const { chainId = client.chain.id, ...operation } = userOperation;
      const hash = isReplayableNonce(operation.nonce)
        ? approvalHash(
            address,
            ...(decodeFunctionData({ abi: gatopagoAccountAbi, data: operation.callData }).args as [
              bigint,
              Hex,
            ]),
          )
        : getUserOperationHash({
            chainId,
            entryPointAddress: entryPoint.address,
            entryPointVersion: entryPoint.version,
            userOperation: { ...operation, sender: address } as UserOperation<'0.9'>,
          });
      return signHash(hash);
    },
  }) as Promise<GatoPagoAccount>;
}

/** EIP-712 request the backend's sponsor key signs (OpenZeppelin PaymasterSigner). */
export function sponsorshipTypedData(parameters: {
  chainId: number;
  paymaster: Address;
  userOperation: Pick<
    UserOperation<'0.9'>,
    | 'sender'
    | 'nonce'
    | 'factory'
    | 'factoryData'
    | 'callData'
    | 'callGasLimit'
    | 'verificationGasLimit'
    | 'preVerificationGas'
    | 'maxFeePerGas'
    | 'maxPriorityFeePerGas'
    | 'paymasterVerificationGasLimit'
    | 'paymasterPostOpGasLimit'
  >;
  validAfter: number;
  validUntil: number;
}) {
  const op = parameters.userOperation;
  const packPair = (high: bigint, low: bigint) =>
    concat([pad(numberToHex(high), { size: 16 }), pad(numberToHex(low), { size: 16 })]);
  return {
    domain: {
      name: 'GatoPagoPaymaster',
      version: '1',
      chainId: parameters.chainId,
      verifyingContract: parameters.paymaster,
    },
    types: {
      UserOperationRequest: [
        { name: 'sender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'initCode', type: 'bytes' },
        { name: 'callData', type: 'bytes' },
        { name: 'accountGasLimits', type: 'bytes32' },
        { name: 'preVerificationGas', type: 'uint256' },
        { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterVerificationGasLimit', type: 'uint256' },
        { name: 'paymasterPostOpGasLimit', type: 'uint256' },
        { name: 'validAfter', type: 'uint48' },
        { name: 'validUntil', type: 'uint48' },
      ],
    },
    primaryType: 'UserOperationRequest',
    message: {
      sender: op.sender,
      nonce: op.nonce,
      initCode: op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x',
      callData: op.callData,
      accountGasLimits: packPair(op.verificationGasLimit, op.callGasLimit),
      preVerificationGas: op.preVerificationGas,
      gasFees: packPair(op.maxPriorityFeePerGas, op.maxFeePerGas),
      paymasterVerificationGasLimit: op.paymasterVerificationGasLimit ?? 0n,
      paymasterPostOpGasLimit: op.paymasterPostOpGasLimit ?? 0n,
      validAfter: parameters.validAfter,
      validUntil: parameters.validUntil,
    },
  } as const;
}

/** `paymasterData` for OpenZeppelin PaymasterSigner: validAfter ‖ validUntil ‖ signature. */
export function sponsorshipPaymasterData(
  validAfter: number,
  validUntil: number,
  signature: Hex,
): Hex {
  return concat([
    numberToHex(validAfter, { size: 6 }),
    numberToHex(validUntil, { size: 6 }),
    signature,
  ]);
}
