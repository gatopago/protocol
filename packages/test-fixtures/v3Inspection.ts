import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { vi } from 'vitest';
import {
  accountInspectionAbi,
  type AccountInspectionInput,
} from '@gatopago/shared/v3/account-inspection';
import { deriveAccountId, predictAccountAddress } from '@gatopago/shared/v3/authorizations';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import { fixtureHash, fixtureManifest } from './v3DeploymentFixture';
export { fixtureHash, fixtureAddress, fixtureManifest } from './v3DeploymentFixture';

// Synthetic protocol fixture only. No actual deployment, audit, source commit or admission.
export const checkpoint = { block_hash: fixtureHash('b'), block_number: '100' };
const commitment = fixtureHash('a');
const salt = fixtureHash('c');
const runtimes = {
  factory: '0x6001',
  implementation: '0x6002',
  security_module: '0x6003',
  upgrade_module: '0x6004',
  proxy: '0x6005',
} as const;

export function fixtureInput(manifest = fixtureManifest()): AccountInspectionInput {
  const document = JSON.stringify(manifest);
  return {
    document,
    expectedDigest: deploymentDocumentDigest(document),
    initialSecurityCommitment: commitment,
    userSaltCommitment: salt,
    checkpoint: { ...checkpoint },
  };
}

function inspectionData() {
  const manifest = fixtureManifest();
  const input = fixtureInput(manifest);
  const accountId = deriveAccountId(commitment, salt);
  const account = predictAccountAddress(
    manifest.components.factory.address,
    accountId,
    manifest.proxy.init_code_hash,
  );
  const state = {
    chainId: toHex(84532),
    genesis: manifest.genesis_hash,
    blockHash: checkpoint.block_hash,
    deployed: true,
    target: manifest.components.implementation.address,
    initHash: manifest.proxy.init_code_hash,
    entryPoint: manifest.entry_point,
    codes: new Map<Address, Hex>([
      ...Object.entries(manifest.components).map(
        ([role, value]) =>
          [value.address, runtimes[role as keyof typeof manifest.components]] as [Address, Hex],
      ),
      [account, runtimes.proxy],
    ]),
    observation: {
      account,
      accountId,
      implementation: manifest.components.implementation.address,
      securityVersion: 2n,
      storageLayoutHash: manifest.storage_layout_hash,
    },
  };
  const request = vi.fn(
    async ({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[];
    }): Promise<unknown> => {
      if (method === 'eth_chainId') return state.chainId;
      if (method === 'eth_getBlockByNumber')
        return params?.[0] === '0x0'
          ? { number: '0x0', hash: state.genesis }
          : { number: '0x64', hash: state.blockHash };
      if (method === 'eth_getCode')
        return params?.[0] === account && !state.deployed
          ? '0x'
          : (state.codes.get(params?.[0] as Address) ?? '0x');
      if (method !== 'eth_call') throw new Error('Unexpected fixture RPC method');
      const call = params?.[0] as { to: Address; data: Hex };
      const decoded = decodeFunctionData({ abi: accountInspectionAbi, data: call.data });
      switch (decoded.functionName) {
        case 'proxyInitCodeHash':
          return encodeFunctionResult({
            abi: accountInspectionAbi,
            functionName: decoded.functionName,
            result: state.initHash,
          });
        case 'entryPoint':
          return encodeFunctionResult({
            abi: accountInspectionAbi,
            functionName: decoded.functionName,
            result: state.entryPoint,
          });
        case 'proxyImplementation':
          return encodeFunctionResult({
            abi: accountInspectionAbi,
            functionName: decoded.functionName,
            result: state.target,
          });
        case 'inspectAccount':
          return encodeFunctionResult({
            abi: accountInspectionAbi,
            functionName: decoded.functionName,
            result: state.observation,
          });
      }
    },
  );
  return { manifest, input, account, state, request };
}

export function inspectionScenario(): ReturnType<typeof inspectionData> & { client: PublicClient } {
  const data = inspectionData();
  const client: PublicClient = createPublicClient({
    transport: custom({ request: data.request }, { retryCount: 0 }),
    cacheTime: 0,
    ccipRead: false,
  });
  return { ...data, client };
}
