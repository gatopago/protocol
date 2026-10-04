import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { MIN_UPGRADE_DELAY_SECONDS } from './constants.mjs';

export const SignerKind = { ECDSA: 0, WEBAUTHN: 1, ERC1271: 2 } as const;
export const Role = { SPEND: 1, ADMIN: 2 } as const;
export const MAX_SIGNERS = 16;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

export interface SignerDescriptor {
  kind: 0 | 1 | 2;
  verifier: Address;
  verifierCodeHash: Hex;
  /** ECDSA/ERC1271: address (20 bytes). WebAuthn: SHA256(rpId)|SHA256(origin)|qx|qy (128 bytes). */
  key: Hex;
  roles: number;
}

export interface SecurityPolicy {
  mode: 'active';
  signers: readonly SignerDescriptor[];
  spendThreshold: number;
  adminThreshold: number;
  upgradeDelaySeconds: number;
}

const SIGNER_TYPEHASH = keccak256(
  stringToHex(
    'SignerDescriptor(uint8 kind,address verifier,bytes32 verifierCodeHash,bytes32 keyHash)',
  ),
);
const MEMBER_TYPEHASH = keccak256(stringToHex('SignerMember(bytes32 signerId,uint8 roles)'));
const POLICY_TYPEHASH = keccak256(
  stringToHex(
    'SecurityPolicy(uint8 mode,bytes32 membersHash,uint16 spendThreshold,uint16 adminThreshold,uint48 upgradeDelaySeconds)',
  ),
);

export function signerId(signer: SignerDescriptor): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        SIGNER_TYPEHASH,
        signer.kind,
        signer.verifier,
        signer.verifierCodeHash,
        keccak256(signer.key),
      ],
    ),
  );
}

/** Keys, not caller-supplied labels or verifier aliases, determine duplicate factors. */
function keyFingerprint(signer: SignerDescriptor): Hex {
  return keccak256(signer.kind === SignerKind.WEBAUTHN ? `0x${signer.key.slice(130)}` : signer.key);
}

function validateSigner(signer: SignerDescriptor): void {
  if (
    [signer.verifier, signer.verifierCodeHash, signer.key].some(
      (value) => typeof value !== 'string' || value.trim() !== value,
    )
  )
    throw new Error('Non-canonical signer encoding');
  if (
    'assisted' in signer ||
    ![0, 1, 2].includes(signer.kind) ||
    !Number.isInteger(signer.roles) ||
    signer.roles < 1 ||
    signer.roles > 3
  )
    throw new Error('Invalid signer roles or kind');
  if (
    !/^0x[0-9a-f]{40}$/.test(signer.verifier) ||
    !/^0x[0-9a-f]{64}$/.test(signer.verifierCodeHash)
  )
    throw new Error('Non-canonical verifier descriptor');
  const length = signer.kind === SignerKind.WEBAUTHN ? 256 : 40;
  if (!new RegExp(`^0x[0-9a-f]{${length}}$`).test(signer.key) || /^0x0+$/.test(signer.key))
    throw new Error('Invalid signer key format');
  if (signer.kind === SignerKind.ECDSA) {
    if (signer.verifier !== ZERO_ADDRESS || signer.verifierCodeHash !== ZERO_HASH)
      throw new Error('ECDSA must use the direct signer profile');
  } else if (signer.verifier === ZERO_ADDRESS || signer.verifierCodeHash === ZERO_HASH) {
    throw new Error('Contract verifiers require pinned address and codehash');
  }
  if (signer.kind === SignerKind.ERC1271 && signer.verifier !== signer.key) {
    throw new Error('ERC1271 verifier must be the contract signer address');
  }
}

/** Structure/threshold checks only: proof of possession, codehash and factor provenance are separate gates. */
export function validateSecurityPolicy(policy: SecurityPolicy): void {
  if (policy.mode !== 'active' || 'recoveryThreshold' in policy || 'recoveryDelaySeconds' in policy)
    throw new Error('Retired or invalid account policy');
  if (policy.signers.length === 0 || policy.signers.length > MAX_SIGNERS)
    throw new Error('Invalid signer count');
  const ids = policy.signers.map((signer) => {
    validateSigner(signer);
    return signerId(signer);
  });
  if (ids.some((id, i) => i > 0 && id <= ids[i - 1]))
    throw new Error('Signers must be unique and sorted by signerId');
  if (new Set(policy.signers.map(keyFingerprint)).size !== ids.length)
    throw new Error('The same key cannot count as multiple factors');
  for (const threshold of [policy.spendThreshold, policy.adminThreshold]) {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_SIGNERS)
      throw new Error('Invalid threshold');
  }
  for (const [delay, minimum] of [[policy.upgradeDelaySeconds, MIN_UPGRADE_DELAY_SECONDS]]) {
    if (!Number.isSafeInteger(delay) || delay < minimum || delay > 30 * 86400)
      throw new Error('Invalid security timelock');
  }
  const count = (role: number) => policy.signers.filter((s) => (s.roles & role) !== 0).length;
  if (
    policy.spendThreshold < 1 ||
    policy.spendThreshold > count(Role.SPEND) ||
    policy.adminThreshold < 1 ||
    policy.adminThreshold > count(Role.ADMIN)
  )
    throw new Error('Unreachable or insufficient threshold');
}

export function hashSecurityPolicy(policy: SecurityPolicy): Hex {
  validateSecurityPolicy(policy);
  const memberHashes = policy.signers.map((signer) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
        [MEMBER_TYPEHASH, signerId(signer), signer.roles],
      ),
    ),
  );
  const membersHash = keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [memberHashes]));
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'bytes32' },
        { type: 'uint16' },
        { type: 'uint16' },
        { type: 'uint48' },
      ],
      [
        POLICY_TYPEHASH,
        1,
        membersHash,
        policy.spendThreshold,
        policy.adminThreshold,
        policy.upgradeDelaySeconds,
      ],
    ),
  );
}
