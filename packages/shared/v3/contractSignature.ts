import {
  encodeAbiParameters,
  hashStruct,
  hashTypedData,
  keccak256,
  parseAbi,
  size,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { ACCOUNT_DOMAIN as accountDomain } from './constants.mjs';
import type { ExecutionSignature } from './execution';

const accountSignatureTypes = {
  AccountSignature: [
    { name: 'accountId', type: 'bytes32' },
    { name: 'generation', type: 'uint32' },
    { name: 'securityVersion', type: 'uint64' },
    { name: 'applicationHash', type: 'bytes32' },
  ],
} as const;
export type AccountSignature = {
  accountId: Hex;
  generation: number;
  securityVersion: bigint;
  applicationHash: Hex;
};
export const ACCOUNT_SIGNATURE_TYPEHASH = keccak256(
  stringToHex(
    'AccountSignature(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 applicationHash)',
  ),
);
export const MAX_ACCOUNT_SIGNATURE_BYTES = 67_776;
export const accountInteropAbi = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);
export const accountSignatureParameters = [
  { type: 'tuple', components: accountSignatureTypes.AccountSignature },
  {
    type: 'tuple[]',
    components: [
      { name: 'signerIndex', type: 'uint8' },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

function checkMessage(message: AccountSignature): void {
  if (
    message.generation !== 3 ||
    message.securityVersion <= 0n ||
    message.securityVersion >= 1n << 64n
  ) {
    throw new Error('Invalid Account V3 signature identity/version');
  }
}

export function accountSignatureStructHash(message: AccountSignature): Hex {
  checkMessage(message);
  return hashStruct({
    primaryType: 'AccountSignature',
    types: accountSignatureTypes,
    data: message,
  });
}

export function accountSignatureDigest(
  chainId: bigint,
  account: Address,
  message: AccountSignature,
): Hex {
  checkMessage(message);
  if (chainId <= 0n) throw new Error('Invalid signature chain');
  return hashTypedData({
    domain: { ...accountDomain, chainId, verifyingContract: account },
    primaryType: 'AccountSignature',
    types: accountSignatureTypes,
    message,
  });
}

export function encodeAccountSignature(
  message: AccountSignature,
  signatures: readonly ExecutionSignature[],
): Hex {
  checkMessage(message);
  const seen = new Set<number>();
  if (signatures.length === 0 || signatures.length > 16) throw new Error('Invalid signature count');
  for (const vote of signatures) {
    if (
      !Number.isInteger(vote.signerIndex) ||
      vote.signerIndex < 0 ||
      vote.signerIndex >= 16 ||
      seen.has(vote.signerIndex) ||
      size(vote.signature) > 4096
    )
      throw new Error('Invalid account signature vote');
    seen.add(vote.signerIndex);
  }
  const envelope = encodeAbiParameters(accountSignatureParameters, [message, signatures]);
  if (size(envelope) > MAX_ACCOUNT_SIGNATURE_BYTES)
    throw new Error('Account signature exceeds envelope budget');
  return envelope;
}
