import { keccak256, type Address, type Hex } from 'viem';
import type { AccountDeploymentManifest } from '@gatopago/shared/v3/deployment';

export const fixtureHash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
export const fixtureAddress = (digit: string) => `0x${digit.repeat(40)}` as Address;
const runtimes = {
  factory: '0x6001',
  implementation: '0x6002',
  security_module: '0x6003',
  upgrade_module: '0x6004',
  proxy: '0x6005',
} as const;
export function fixtureManifest() {
  const component = (
    role: 'factory' | 'implementation' | 'security_module' | 'upgrade_module',
    digit: string,
  ) => ({
    address: fixtureAddress(digit),
    deployer: fixtureAddress('9'),
    salt: null,
    creation_code_hash: fixtureHash('d'),
    runtime_code_hash: keccak256(runtimes[role]),
    abi_sha256: fixtureHash('e'),
    source_commit: 'a'.repeat(40),
    source_tree_sha256: fixtureHash('f'),
    dependency_lock_sha256: fixtureHash('1'),
    build_info_sha256: fixtureHash('2'),
    compiler: { version: '0.8.34', optimizer_runs: 200, via_ir: true, evm_version: 'cancun' },
    deployment_tx: fixtureHash(digit),
    deployed_block: '10',
    verification_url: 'https://example.com/contract/fixture',
  });
  return {
    schema_version: 1,
    generation: 3,
    manifest_id: '12345678-1234-4123-8123-123456789012',
    network_id: 'eip155:84532',
    genesis_hash: fixtureHash('7'),
    lifecycle_status: 'deployed',
    entry_point: fixtureAddress('8'),
    storage_layout_hash: fixtureHash('6'),
    proxy: {
      runtime_code_hash: keccak256(runtimes.proxy),
      init_code_hash: fixtureHash('3'),
      artifact_sha256: fixtureHash('4'),
    },
    components: {
      factory: component('factory', '1'),
      implementation: component('implementation', '2'),
      security_module: component('security_module', '3'),
      upgrade_module: component('upgrade_module', '4'),
    },
  } satisfies AccountDeploymentManifest;
}
