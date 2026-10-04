import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { vi } from 'vitest';
import {
  creationInspectionAbi,
  type CreationInspectionInput,
} from '@gatopago/shared/v3/creation-inspection';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import { initializationFixture } from './v3Initialization';
import { checkpoint } from './v3Inspection';

function creationInspectionData() {
  const initial = initializationFixture();
  const codes = new Map<Address, Hex>();
  const components = Object.fromEntries(
    Object.entries(initial.profile.deployment.components).map(([role, component], index) => {
      const runtime = `0x60${String(index + 1).padStart(2, '0')}` as Hex;
      codes.set(component.address, runtime);
      return [role, { ...component, runtime_code_hash: keccak256(runtime) }];
    }),
  ) as typeof initial.profile.deployment.components;
  const profile = {
    ...initial.profile,
    deployment: { ...initial.profile.deployment, components },
    entry_point_code_hash: keccak256('0x6005'),
    sender_creator: { ...initial.profile.sender_creator, runtime_code_hash: keccak256('0x6006') },
    webauthn_verifier: {
      ...initial.profile.webauthn_verifier,
      runtime_code_hash: keccak256('0x6007'),
    },
  };
  codes.set(profile.deployment.entry_point, '0x6005');
  codes.set(profile.sender_creator.address, '0x6006');
  codes.set(profile.webauthn_verifier.address, '0x6007');
  const document = JSON.stringify(profile);
  const input: CreationInspectionInput = {
    document,
    expectedDigest: deploymentDocumentDigest(document),
    checkpoint: { ...checkpoint },
  };
  const factory = components.factory.address,
    implementation = components.implementation.address,
    ep = profile.deployment.entry_point;
  const getters = new Map<string, Hex>();
  const address = (to: Address, getter: string, value: Address) =>
    getters.set(`${to}:${getter}`, encodeAbiParameters([{ type: 'address' }], [value]));
  const hash = (to: Address, getter: string, value: Hex) => getters.set(`${to}:${getter}`, value);
  address(factory, 'implementation', implementation);
  address(factory, 'entryPoint', ep);
  address(factory, 'senderCreator', profile.sender_creator.address);
  hash(factory, 'implementationCodeHash', components.implementation.runtime_code_hash);
  hash(factory, 'entryPointCodeHash', profile.entry_point_code_hash);
  hash(factory, 'senderCreatorCodeHash', profile.sender_creator.runtime_code_hash);
  hash(factory, 'securityModuleCodeHash', components.security_module.runtime_code_hash);
  hash(factory, 'upgradeModuleCodeHash', components.upgrade_module.runtime_code_hash);
  hash(factory, 'proxyInitCodeHash', profile.deployment.proxy.init_code_hash);
  address(ep, 'senderCreator', profile.sender_creator.address);
  address(implementation, 'initializationEntryPoint', ep);
  address(implementation, 'entryPoint', ep);
  address(implementation, 'securityModule', components.security_module.address);
  hash(implementation, 'securityModuleCodeHash', components.security_module.runtime_code_hash);
  address(implementation, 'upgradeModule', components.upgrade_module.address);
  hash(implementation, 'upgradeModuleCodeHash', components.upgrade_module.runtime_code_hash);
  hash(implementation, 'storageLayoutHash', profile.deployment.storage_layout_hash);
  hash(
    implementation,
    'proxiableUUID',
    toHex(BigInt(keccak256(stringToHex('eip1967.proxy.implementation'))) - 1n, { size: 32 }),
  );
  const state = {
    chainId: toHex(84532),
    genesis: profile.deployment.genesis_hash,
    blockHash: checkpoint.block_hash,
    codes,
    getters,
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
      if (method === 'eth_getCode') return state.codes.get(params?.[0] as Address) ?? '0x';
      if (method === 'eth_call') {
        const call = params?.[0] as { to: Address; data: Hex };
        const decoded = decodeFunctionData({ abi: creationInspectionAbi, data: call.data });
        const value = state.getters.get(`${call.to}:${decoded.functionName}`);
        if (!value) throw new Error('Unexpected getter');
        return value;
      }
      throw new Error('Unexpected fixture RPC method');
    },
  );
  return { input, profile, state, request };
}

export function creationInspectionScenario(): ReturnType<typeof creationInspectionData> & {
  client: PublicClient;
} {
  const data = creationInspectionData();
  const client: PublicClient = createPublicClient({
    transport: custom({ request: data.request }, { retryCount: 0 }),
    cacheTime: 0,
    ccipRead: false,
  });
  return { ...data, client };
}
