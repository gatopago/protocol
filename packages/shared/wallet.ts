import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  hexToBigInt,
  numberToHex,
  pad,
  parseAbi,
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
import { readContract } from 'viem/actions';
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
  'function isSigner(bytes signer) view returns (bool)',
  'function getSigners(uint64 start, uint64 end) view returns (bytes[])',
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

/** ERC-7579 batch mode: callType 0x01, default exec type, no selector or payload. */
const BATCH_MODE = pad('0x01', { dir: 'right', size: 32 });
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** ERC-7913 signer for a passkey: verifier ‖ x ‖ y. Accepts 64-byte or 0x04-prefixed keys. */
export function passkeyOwner(webAuthnVerifier: Address, publicKey: Hex): Hex {
  const key = size(publicKey) === 65 ? slice(publicKey, 1) : publicKey;
  if (size(key) !== 64) throw new Error('INVALID_PASSKEY_PUBLIC_KEY');
  return concat([webAuthnVerifier, key]);
}

/** `abi.encode([owner], [WebAuthnAuth])`, the format OpenZeppelin's MultiSignerERC7913 expects. */
export function encodePasskeySignature(
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
  return encodeAbiParameters([{ type: 'bytes[]' }, { type: 'bytes[]' }], [[owner], [auth]]);
}

/** Chain-independent hash an owner signs to approve `call` as approval number `sequence`. */
export function approvalHash(account: Address, sequence: bigint, call: Hex): Hex {
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

export const isReplayableNonce = (nonce: bigint) => nonce >> 64n === REPLAYABLE_NONCE_KEY;

const erc7913VerifierAbi = parseAbi([
  'function verify(bytes key, bytes32 hash, bytes signature) view returns (bytes4)',
]);
const ERC7913_VALID = toFunctionSelector('verify(bytes,bytes32,bytes)');

/** Owners after applying `calls` (approved `addOwners` / `removeOwners`, in order) to the initial owners. */
export function ownersAfter(initialOwners: readonly Hex[], calls: readonly Hex[]): Hex[] {
  const owners = new Set(initialOwners.map((owner) => owner.toLowerCase() as Hex));
  for (const call of calls) {
    const { functionName, args } = decodeFunctionData({ abi: gatopagoAccountAbi, data: call });
    if (functionName === 'addOwners')
      for (const owner of args[0]) owners.add(owner.toLowerCase() as Hex);
    if (functionName === 'removeOwners')
      for (const owner of args[0]) owners.delete(owner.toLowerCase() as Hex);
  }
  return [...owners];
}

/**
 * Whether `signature` is the next approval of `account`: signed by an owner at that point (the initial
 * owners plus the `previous` approvals) and valid for that owner's ERC-7913 verifier, the same check the
 * account runs onchain. Lets a server store approvals for other networks without trusting the client.
 */
export async function verifyApproval(
  client: Client,
  parameters: {
    account: Address;
    initialOwners: readonly Hex[];
    previous: readonly Hex[];
    call: Hex;
    signature: Hex;
  },
): Promise<boolean> {
  const { account, initialOwners, previous, call, signature } = parameters;
  try {
    const [signers, signatures] = decodeAbiParameters(
      [{ type: 'bytes[]' }, { type: 'bytes[]' }],
      signature,
    );
    const owners = ownersAfter(initialOwners, previous);
    if (signers.length !== 1 || !owners.includes(signers[0].toLowerCase() as Hex)) return false;
    const valid = await readContract(client, {
      address: slice(signers[0], 0, 20),
      abi: erc7913VerifierAbi,
      functionName: 'verify',
      args: [
        slice(signers[0], 20),
        approvalHash(account, BigInt(previous.length), call),
        signatures[0],
      ],
    });
    return valid === ERC7913_VALID;
  } catch {
    return false;
  }
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
      owner: WebAuthnAccount;
      initialOwners: readonly Hex[];
      /** Passkey signature over `hash` in the account's signature format. */
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
 * viem smart account for a GatoPago account signed by `owner`. The address derives from the
 * account's initial owners, so a backup passkey must pass the original `initialOwners`.
 */
export async function toGatoPagoAccount(parameters: {
  client: Client<Transport, Chain, JsonRpcAccount | LocalAccount | undefined>;
  owner: WebAuthnAccount;
  contracts: Pick<WalletContracts, 'factory' | 'webAuthnVerifier'>;
  initialOwners?: readonly Hex[];
  salt?: bigint;
}): Promise<GatoPagoAccount> {
  const { client, owner, contracts, salt = 0n } = parameters;
  const signer = passkeyOwner(contracts.webAuthnVerifier, owner.publicKey);
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
  const verifierDomain = {
    name: 'GatoPagoAccount',
    version: '1',
    chainId: client.chain.id,
    verifyingContract: address,
    salt: zeroHash,
  } as const;
  async function signHash(hash: Hex) {
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
