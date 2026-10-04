import {
  encodeAbiParameters,
  getContractAddress,
  hashTypedData,
  hashStruct,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type MessageDefinition,
  type TypedDataDefinition,
} from 'viem';
import { ACCOUNT_GENERATION } from './constants.mjs';
import { ACCOUNT_DOMAIN as accountDomain } from './constants.mjs';
export { ACCOUNT_DOMAIN as accountDomain } from './constants.mjs';
export { ACCOUNT_GENERATION, MIN_UPGRADE_DELAY_SECONDS } from './constants.mjs';

/** E0 candidate protocol: policy proposals bind acceptance and completion deadlines separately.
 * Account V3 deployment is blocked until Gate A closes. */
export const ACCOUNT_ID_TYPE =
  'AccountIdentity(uint32 generation,bytes32 initialSecurityCommitment,bytes32 userSaltCommitment)';
export const ACCOUNT_ID_TYPEHASH = keccak256(stringToHex(ACCOUNT_ID_TYPE));

export const authorizationTypes = {
  InitializationApproval: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'initialSecurityCommitment', type: 'bytes32' },
    { name: 'userSaltCommitment', type: 'bytes32' },
    { name: 'factory', type: 'address' },
    { name: 'entryPoint', type: 'address' },
    { name: 'chainScopeHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  EnrollmentProof: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'signerId', type: 'bytes32' },
    { name: 'nextPolicyHash', type: 'bytes32' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  CancelProposal: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'proposalHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  FreezeUpgrades: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'previousManifestHash', type: 'bytes32' },
    { name: 'chainScopeHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  CommitProposal: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'previousManifestHash', type: 'bytes32' },
    { name: 'proposalHash', type: 'bytes32' },
    { name: 'acknowledgementsHash', type: 'bytes32' },
    { name: 'chainScopeHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  ExecutionPlan: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'executionMode', type: 'uint8' },
    { name: 'entryPoint', type: 'address' },
    { name: 'userOpHash', type: 'bytes32' },
    { name: 'callsHash', type: 'bytes32' },
    { name: 'assetLimitsHash', type: 'bytes32' },
    { name: 'feePolicyHash', type: 'bytes32' },
    { name: 'paymaster', type: 'address' },
    { name: 'previewHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
  SecurityChange: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'previousManifestHash', type: 'bytes32' },
    { name: 'nextPolicyHash', type: 'bytes32' },
    { name: 'chainScopeHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'proposalValidUntil', type: 'uint48' },
  ],
  UpgradeManifest: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'previousManifestHash', type: 'bytes32' },
    { name: 'implementation', type: 'address' },
    { name: 'runtimeCodeHash', type: 'bytes32' },
    { name: 'storageLayoutHash', type: 'bytes32' },
    { name: 'chainScopeHash', type: 'bytes32' },
    { name: 'migrationCallHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
  ],
} as const;

export type AuthorizationKind = keyof typeof authorizationTypes;
export type AuthorizationMessages = {
  InitializationApproval: MessageDefinition<
    typeof authorizationTypes,
    'InitializationApproval'
  >['message'];
  EnrollmentProof: MessageDefinition<typeof authorizationTypes, 'EnrollmentProof'>['message'];
  CancelProposal: MessageDefinition<typeof authorizationTypes, 'CancelProposal'>['message'];
  FreezeUpgrades: MessageDefinition<typeof authorizationTypes, 'FreezeUpgrades'>['message'];
  CommitProposal: MessageDefinition<typeof authorizationTypes, 'CommitProposal'>['message'];
  ExecutionPlan: MessageDefinition<typeof authorizationTypes, 'ExecutionPlan'>['message'];
  SecurityChange: MessageDefinition<typeof authorizationTypes, 'SecurityChange'>['message'];
  UpgradeManifest: MessageDefinition<typeof authorizationTypes, 'UpgradeManifest'>['message'];
};
export type ExecutionPlan = AuthorizationMessages['ExecutionPlan'];

/** Chain-neutral policy state; per-chain consent digests and receipts are separate evidence. */
export interface SecurityManifest {
  accountId: Hex;
  generation: number;
  securityVersion: bigint;
  previousManifestHash: Hex;
  policyHash: Hex;
  chainScopeHash: Hex;
}

export function hashSecurityManifest(manifest: SecurityManifest): Hex {
  if (manifest.generation !== ACCOUNT_GENERATION || manifest.securityVersion < 1n)
    throw new Error('Invalid security manifest version');
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        keccak256(
          stringToHex(
            'SecurityManifest(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,bytes32 policyHash,bytes32 chainScopeHash)',
          ),
        ),
        manifest.accountId,
        manifest.generation,
        manifest.securityVersion,
        manifest.previousManifestHash,
        manifest.policyHash,
        manifest.chainScopeHash,
      ],
    ),
  );
}

export function authorizationTypeHash(kind: AuthorizationKind): Hex {
  const fields = authorizationTypes[kind].map((field) => `${field.type} ${field.name}`).join(',');
  return keccak256(stringToHex(`${kind}(${fields})`));
}

export function authorizationStructHash<K extends AuthorizationKind>(
  kind: K,
  message: AuthorizationMessages[K],
): Hex {
  return hashStruct<typeof authorizationTypes, AuthorizationKind>({
    data: message,
    types: authorizationTypes,
    primaryType: kind,
  });
}

export function deriveAccountId(initialSecurityCommitment: Hex, userSaltCommitment: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [ACCOUNT_ID_TYPEHASH, ACCOUNT_GENERATION, initialSecurityCommitment, userSaltCommitment],
    ),
  );
}

export function predictAccountAddress(
  factory: Address,
  accountId: Hex,
  proxyInitCodeHash: Hex,
): Address {
  return getContractAddress({
    from: factory,
    opcode: 'CREATE2',
    salt: accountId,
    bytecodeHash: proxyInitCodeHash,
  });
}

/** Sorted, unique scope prevents alternate encodings of the same set of chains. */
export function hashChainScope(chainIds: readonly bigint[]): Hex {
  if (chainIds.length === 0 || chainIds.length > 32) throw new Error('Invalid chain scope size');
  for (let i = 0; i < chainIds.length; i++) {
    if (chainIds[i] <= 0n || (i > 0 && chainIds[i] <= chainIds[i - 1])) {
      throw new Error('Chain scope must be positive, unique and sorted');
    }
  }
  return keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [chainIds]));
}

export type AccountCall = { target: Address; value: bigint; data: Hex };

export function hashCalls(calls: readonly AccountCall[]): Hex {
  if (calls.length === 0 || calls.length > 32) throw new Error('Invalid batch size');
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
      [calls],
    ),
  );
}

export function authorizationDigest<K extends AuthorizationKind>(
  kind: K,
  chainId: bigint,
  account: Address,
  message: AuthorizationMessages[K],
): Hex {
  if (chainId <= 0n || message.generation !== ACCOUNT_GENERATION)
    throw new Error('Invalid authorization domain');
  if (message.validUntil <= message.validAfter) throw new Error('Invalid authorization window');
  // The v0.9 EntryPoint reserves the high bits for block ranges. V3 signs a
  // half-open timestamp range; Solidity subtracts one from each bound.
  if (
    (kind === 'InitializationApproval' || kind === 'ExecutionPlan') &&
    (message.validAfter < 1 || message.validUntil > 0x7fffffffffff)
  ) {
    throw new Error('EntryPoint authorization requires a positive 47-bit timestamp window');
  }
  const typedData = {
    domain: { ...accountDomain, chainId, verifyingContract: account },
    types: authorizationTypes,
    primaryType: kind,
    message,
  } as TypedDataDefinition<typeof authorizationTypes>;
  return hashTypedData(typedData);
}
