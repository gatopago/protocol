import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  authorizationDigest,
  deriveAccountId,
  hashChainScope,
  predictAccountAddress,
} from './authorizations';
import { MIN_UPGRADE_DELAY_SECONDS } from './constants.mjs';
import {
  deploymentDocumentDigest,
  loadPinnedDeploymentManifest,
  requireDeploymentAddress,
  requireHash,
  validateDeploymentComponent,
  type AccountDeploymentManifest,
  type DeploymentComponent,
} from './deployment';
import { evmChainId } from './primitives';
import { hashSecurityPolicy, Role, SignerKind, type SecurityPolicy } from './securityPolicy';
import {
  assertWebAuthnKey,
  encodeWebAuthnAssertion,
  type WebAuthnAssertionBytes,
  type WebAuthnScope,
} from './webauthn';
import { validateCreationShape } from './wire-validators.mjs';

export interface AccountCreationProfile {
  readonly schema_version: 1;
  readonly purpose: 'account_creation';
  readonly deployment: AccountDeploymentManifest;
  readonly proxy_creation_code: Hex;
  readonly webauthn_verifier: DeploymentComponent;
  readonly entry_point_code_hash: Hex;
  readonly sender_creator: Readonly<{ address: Address; runtime_code_hash: Hex }>;
}

function creationShape(value: unknown): value is AccountCreationProfile {
  return validateCreationShape(value);
}
export function loadPinnedCreationProfile(
  document: string,
  expectedDigest: Hex,
): AccountCreationProfile {
  requireHash(expectedDigest);
  if (deploymentDocumentDigest(document) !== expectedDigest)
    throw new Error('Creation profile pin mismatch');
  const value: unknown = JSON.parse(document);
  if (!creationShape(value)) throw new Error('Invalid creation profile schema');

  const nested = JSON.stringify(value.deployment);
  const deployment = loadPinnedDeploymentManifest(nested, deploymentDocumentDigest(nested));
  if (deployment.lifecycle_status !== 'deployed')
    throw new Error('Creation deployment is not deployed');
  validateDeploymentComponent(value.webauthn_verifier);
  requireHash(value.entry_point_code_hash);
  requireHash(value.sender_creator.runtime_code_hash);
  requireDeploymentAddress(value.sender_creator.address);
  const addresses = [
    deployment.entry_point,
    ...Object.values(deployment.components).map((item) => item.address),
    value.webauthn_verifier.address,
    value.sender_creator.address,
  ];
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length)
    throw new Error('Creation roles overlap');
  const code = concatHex([
    value.proxy_creation_code,
    encodeAbiParameters([{ type: 'address' }], [deployment.components.implementation.address]),
  ]);
  if (keccak256(code) !== deployment.proxy.init_code_hash)
    throw new Error('Original proxy recipe mismatch');
  return Object.freeze({
    ...value,
    deployment,
    sender_creator: Object.freeze({ ...value.sender_creator }),
  });
}

export const accountCreationAbi = parseAbi([
  'struct SignerDescriptor { uint8 kind; address verifier; bytes32 verifierCodeHash; bytes key; uint8 roles; }',
  'struct SecurityPolicy { uint8 mode; SignerDescriptor[] signers; uint16 spendThreshold; uint16 adminThreshold; uint48 upgradeDelaySeconds; }',
  'struct InitializationApproval { bytes32 accountId; uint32 generation; bytes32 initialSecurityCommitment; bytes32 userSaltCommitment; address factory; address entryPoint; bytes32 chainScopeHash; uint256 nonce; uint48 validAfter; uint48 validUntil; }',
  'struct Signature { uint8 signerIndex; bytes signature; }',
  'function createAccount(InitializationApproval message, SecurityPolicy policy, uint256[] chains, Signature[] proofs) returns (address account)',
]);

export interface InitializationInput {
  readonly document: string;
  readonly expectedDigest: Hex;
  readonly scope: WebAuthnScope;
  readonly publicKey: Hex;
  readonly userSaltCommitment: Hex;
  readonly validAfter: number;
  readonly validUntil: number;
}

export function prepareInitialization(input: InitializationInput) {
  const profile = loadPinnedCreationProfile(input.document, input.expectedDigest);
  const scope = Object.freeze({ ...input.scope });
  assertWebAuthnKey(scope, input.publicKey);
  requireHash(input.userSaltCommitment);
  if (
    !Number.isSafeInteger(input.validAfter) ||
    !Number.isSafeInteger(input.validUntil) ||
    input.validAfter < 1 ||
    input.validUntil > 0x7fffffffffff ||
    input.validUntil <= input.validAfter ||
    input.validUntil - input.validAfter > 300
  ) {
    throw new Error('Invalid initialization lifetime');
  }
  const verifier = profile.webauthn_verifier;
  const policy: SecurityPolicy = Object.freeze({
    mode: 'active',
    signers: Object.freeze([
      Object.freeze({
        kind: SignerKind.WEBAUTHN,
        verifier: verifier.address,
        verifierCodeHash: verifier.runtime_code_hash,
        key: input.publicKey,
        roles: Role.SPEND | Role.ADMIN,
      }),
    ]),
    spendThreshold: 1,
    adminThreshold: 1,
    upgradeDelaySeconds: MIN_UPGRADE_DELAY_SECONDS,
  });
  const initialSecurityCommitment = hashSecurityPolicy(policy);
  const accountId = deriveAccountId(initialSecurityCommitment, input.userSaltCommitment);
  const chainId = evmChainId(profile.deployment.network_id),
    chains = Object.freeze([chainId]);
  const account = predictAccountAddress(
    profile.deployment.components.factory.address,
    accountId,
    profile.deployment.proxy.init_code_hash,
  );
  const message = Object.freeze({
    accountId,
    generation: 3,
    initialSecurityCommitment,
    userSaltCommitment: input.userSaltCommitment,
    factory: profile.deployment.components.factory.address,
    entryPoint: profile.deployment.entry_point,
    chainScopeHash: hashChainScope(chains),
    nonce: 0n,
    validAfter: input.validAfter,
    validUntil: input.validUntil,
  });
  const digest = authorizationDigest('InitializationApproval', chainId, account, message);
  return Object.freeze({
    profile,
    scope,
    policy,
    account,
    chainId,
    chains,
    message,
    digest,
    profileDigest: input.expectedDigest,
  });
}

export function authorizeInitialization(
  input: InitializationInput,
  assertion: WebAuthnAssertionBytes,
  now: number,
) {
  const prepared = prepareInitialization(input);
  if (
    !Number.isSafeInteger(now) ||
    now < prepared.message.validAfter ||
    now >= prepared.message.validUntil
  ) {
    throw new Error('Initialization authorization expired or not yet valid');
  }
  const signature = encodeWebAuthnAssertion({
    scope: prepared.scope,
    key: prepared.policy.signers[0].key,
    challenge: prepared.digest,
    response: assertion,
  });
  const factoryData = encodeFunctionData({
    abi: accountCreationAbi,
    functionName: 'createAccount',
    args: [
      prepared.message,
      { ...prepared.policy, mode: 1 },
      prepared.chains,
      [{ signerIndex: 0, signature }],
    ],
  });
  return Object.freeze({
    digest: prepared.digest,
    account: prepared.account,
    factory: prepared.message.factory,
    factoryData,
    initCode: concatHex([prepared.message.factory, factoryData]),
    signature,
  });
}
