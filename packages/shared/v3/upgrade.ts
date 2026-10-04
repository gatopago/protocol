import {
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseAbi,
  size,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { authorizationDigest, hashChainScope, type AuthorizationMessages } from './authorizations';
import type { ExecutionSignature } from './execution';

export type UpgradeManifest = AuthorizationMessages['UpgradeManifest'];
export type UpgradeCommit = AuthorizationMessages['CommitProposal'];

/** Internal candidate transport, not a registry of reviewed or deployed implementations. */
export const accountUpgradeAbi = parseAbi([
  'struct Signature { uint8 signerIndex; bytes signature; }',
  'struct UpgradeManifest { bytes32 accountId; uint32 generation; uint64 securityVersion; bytes32 previousManifestHash; address implementation; bytes32 runtimeCodeHash; bytes32 storageLayoutHash; bytes32 chainScopeHash; bytes32 migrationCallHash; uint256 nonce; uint48 validAfter; uint48 validUntil; }',
  'struct CommitProposal { bytes32 accountId; uint32 generation; uint64 securityVersion; bytes32 previousManifestHash; bytes32 proposalHash; bytes32 acknowledgementsHash; bytes32 chainScopeHash; uint256 nonce; uint48 validAfter; uint48 validUntil; }',
  'function proposeUpgrade(UpgradeManifest message, uint256[] chains, Signature[] signatures) returns (bytes32)',
  'function commitUpgrade(CommitProposal message, bytes migration, Signature[] signatures)',
  'function storageLayoutHash() view returns (bytes32)',
  'function upgradeCompatibility(bytes32 previousLayout, address ep, uint32 generation) view returns (bytes32)',
  'function upgradeModule() view returns (address)',
  'function upgradeModuleCodeHash() view returns (bytes32)',
]);

function checkVotes(signatures: readonly ExecutionSignature[]): void {
  // Structural minimum only: distinct indices are not proof of independent factors or valid roles.
  if (signatures.length < 2 || signatures.length > 16)
    throw new Error('Upgrade requires administrative quorum');
  const seen = new Set<number>();
  for (const vote of signatures) {
    if (
      !Number.isInteger(vote.signerIndex) ||
      vote.signerIndex < 0 ||
      vote.signerIndex >= 16 ||
      seen.has(vote.signerIndex) ||
      size(vote.signature) > 4096
    )
      throw new Error('Invalid upgrade vote');
    seen.add(vote.signerIndex);
  }
}

function checkVersion(message: UpgradeManifest | UpgradeCommit): void {
  if (
    message.generation !== 3 ||
    message.securityVersion <= 0n ||
    message.securityVersion >= 1n << 64n ||
    message.accountId === zeroHash ||
    message.previousManifestHash === zeroHash
  )
    throw new Error('Invalid upgrade identity/version');
}

/** The wait starts when the proposal is accepted ONCHAIN, not at message.validAfter. */
export function encodeUpgradeProposal(
  account: Address,
  chainId: bigint,
  message: UpgradeManifest,
  chains: readonly bigint[],
  signatures: readonly ExecutionSignature[],
): Hex {
  checkVersion(message);
  checkVotes(signatures);
  if (
    isAddressEqual(message.implementation, zeroAddress) ||
    isAddressEqual(message.implementation, account) ||
    message.runtimeCodeHash === zeroHash ||
    message.storageLayoutHash === zeroHash ||
    !chains.includes(chainId) ||
    hashChainScope(chains) !== message.chainScopeHash
  )
    throw new Error('Invalid upgrade target/scope');
  authorizationDigest('UpgradeManifest', chainId, account, message);
  return encodeFunctionData({
    abi: accountUpgradeAbi,
    functionName: 'proposeUpgrade',
    args: [message, chains, signatures],
  });
}

/** Exact migration and a different typed signature. Never route this through executeSigned,
 * nor treat a successful metadata read as an audit of new code. The Worker/signer must verify
 * the admitted artifact, onchain proposal, current policy, readiness and simulation separately.
 */
export function encodeUpgradeCommit(
  account: Address,
  chainId: bigint,
  proposal: UpgradeManifest,
  message: UpgradeCommit,
  migration: Hex,
  signatures: readonly ExecutionSignature[],
): Hex {
  checkVersion(proposal);
  checkVersion(message);
  checkVotes(signatures);
  if (
    message.accountId !== proposal.accountId ||
    message.securityVersion !== proposal.securityVersion ||
    message.previousManifestHash !== proposal.previousManifestHash ||
    message.chainScopeHash !== proposal.chainScopeHash ||
    message.proposalHash !== authorizationDigest('UpgradeManifest', chainId, account, proposal) ||
    message.acknowledgementsHash === zeroHash ||
    message.nonce <= proposal.nonce ||
    keccak256(migration) !== proposal.migrationCallHash
  )
    throw new Error('Upgrade commit does not match its proposal');
  authorizationDigest('CommitProposal', chainId, account, message);
  return encodeFunctionData({
    abi: accountUpgradeAbi,
    functionName: 'commitUpgrade',
    args: [message, migration, signatures],
  });
}
