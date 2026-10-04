import {
  getContractAddress,
  isAddress,
  isAddressEqual,
  sha256,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { evmChainId, parseAtomicAmount, type NetworkId } from './primitives';
import { validateDeploymentShape } from './wire-validators.mjs';

export interface DeploymentComponent {
  readonly address: Address;
  readonly deployer: Address;

  readonly salt: Hex | null;
  readonly creation_code_hash: Hex;

  readonly runtime_code_hash: Hex;
  readonly abi_sha256: Hex;
  readonly source_commit: string;
  readonly source_tree_sha256: Hex;
  readonly dependency_lock_sha256: Hex;
  readonly build_info_sha256: Hex;
  readonly compiler: Readonly<{
    version: string;
    optimizer_runs: number;
    via_ir: boolean;
    evm_version: string;
  }>;
  readonly deployment_tx: Hex;
  readonly deployed_block: string;
  readonly verification_url: string | null;
}

export interface AccountDeploymentManifest {
  readonly schema_version: 1;
  readonly generation: 3;
  readonly manifest_id: string;
  readonly network_id: NetworkId;
  readonly genesis_hash: Hex;
  readonly lifecycle_status: 'candidate' | 'deployed' | 'retired';
  readonly entry_point: Address;
  readonly storage_layout_hash: Hex;
  readonly proxy: Readonly<{ runtime_code_hash: Hex; init_code_hash: Hex; artifact_sha256: Hex }>;
  readonly components: Readonly<
    Record<'factory' | 'implementation' | 'security_module' | 'upgrade_module', DeploymentComponent>
  >;
}

export function requireHash(value: unknown): asserts value is Hex {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-f]{64}$(?![\s\S])/.test(value) ||
    value === zeroHash
  ) {
    throw new Error('Invalid nonzero bytes32');
  }
}

export function requireDeploymentAddress(value: Address): void {
  if (!isAddress(value, { strict: true }) || value === zeroAddress)
    throw new Error('Invalid deployment address');
}

export function validateDeploymentComponent(component: DeploymentComponent): void {
  requireDeploymentAddress(component.address);
  requireDeploymentAddress(component.deployer);
  for (const hash of [
    component.creation_code_hash,
    component.runtime_code_hash,
    component.abi_sha256,
    component.source_tree_sha256,
    component.dependency_lock_sha256,
    component.build_info_sha256,
    component.deployment_tx,
  ])
    requireHash(hash);
  if (/^0{40}$/.test(component.source_commit)) throw new Error('Missing source commit');
  parseAtomicAmount(component.deployed_block);
  if (
    component.salt !== null &&
    !isAddressEqual(
      component.address,
      getContractAddress({
        from: component.deployer,
        opcode: 'CREATE2',
        salt: component.salt,
        bytecodeHash: component.creation_code_hash,
      }),
    )
  ) {
    throw new Error('Deployment CREATE2 address does not match its recipe');
  }
  if (component.verification_url !== null) {
    if (component.verification_url.length > 2048) throw new Error('Invalid verification URL');
    const url = new URL(component.verification_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid verification URL');
  }
  Object.freeze(component.compiler);
  Object.freeze(component);
}

function isManifest(value: unknown): value is AccountDeploymentManifest {
  return validateDeploymentShape(value);
}

export function deploymentDocumentDigest(document: string): Hex {
  if (
    typeof document !== 'string' ||
    document.length > 65_536 ||
    new TextEncoder().encode(document).length > 65_536
  ) {
    throw new Error('Deployment manifest exceeds 64 KiB');
  }
  return sha256(stringToHex(document));
}

export function loadPinnedDeploymentManifest(
  document: string,
  expectedDigest: Hex,
): AccountDeploymentManifest {
  requireHash(expectedDigest);
  if (deploymentDocumentDigest(document) !== expectedDigest)
    throw new Error('Deployment manifest pin mismatch');
  const value: unknown = JSON.parse(document);
  if (!isManifest(value)) throw new Error('Invalid deployment manifest schema');
  evmChainId(value.network_id);
  requireDeploymentAddress(value.entry_point);
  requireHash(value.genesis_hash);
  requireHash(value.storage_layout_hash);
  for (const hash of Object.values(value.proxy)) requireHash(hash);
  const addresses = new Set([value.entry_point]);
  for (const component of Object.values(value.components)) {
    validateDeploymentComponent(component);
    if (addresses.has(component.address))
      throw new Error('Deployment roles must have distinct addresses');
    addresses.add(component.address);
  }
  Object.freeze(value.components);
  Object.freeze(value.proxy);
  return Object.freeze(value);
}
