import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, toHex,
	type Address, type Hex, type PublicClient } from 'viem';
import type { InspectionCheckpoint } from './accountInspection';
import { requireHash } from './deployment';
import { loadPinnedCreationProfile } from './initialization';
import { evmChainId, parseAtomicAmount } from './primitives';

export const creationInspectionAbi = parseAbi([
	'function implementation() view returns (address)',
	'function entryPoint() view returns (address)',
	'function senderCreator() view returns (address)',
	'function implementationCodeHash() view returns (bytes32)',
	'function entryPointCodeHash() view returns (bytes32)',
	'function senderCreatorCodeHash() view returns (bytes32)',
	'function securityModuleCodeHash() view returns (bytes32)',
	'function upgradeModuleCodeHash() view returns (bytes32)',
	'function proxyInitCodeHash() view returns (bytes32)',
	'function initializationEntryPoint() view returns (address)',
	'function securityModule() view returns (address)',
	'function upgradeModule() view returns (address)',
	'function storageLayoutHash() view returns (bytes32)',
	'function proxiableUUID() view returns (bytes32)',
]);

export interface CreationInspectionInput {
	readonly document: string;
	/** Independently reviewed original-composition pin, never supplied by the payer. */
	readonly expectedDigest: Hex;
	/** Chain/finality policy chooses this checkpoint, not arbitrary HTTP parameters. */
	readonly checkpoint: InspectionCheckpoint;
}

export class CreationInspectionError extends Error {
	constructor(readonly code: 'CHAIN_MISMATCH' | 'CHECKPOINT_MISMATCH' | 'INVALID_RPC_DATA' | 'UNEXPECTED_CODE'
		| 'COMPOSITION_MISMATCH' | 'RPC_UNAVAILABLE') { super(code); this.name = 'CreationInspectionError'; }
}
const error = (code: CreationInspectionError['code']): never => { throw new CreationInspectionError(code); };
function quantity(value: unknown): bigint {
	if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$(?![\s\S])/.test(value)) return error('INVALID_RPC_DATA');
	return BigInt(value);
}
function data(value: unknown, maximum: number): Hex {
	if (typeof value !== 'string' || value.length > 2 + maximum * 2 || !/^0x(?:[0-9a-fA-F]{2})*$(?![\s\S])/.test(value)) return error('INVALID_RPC_DATA');
	return value.toLowerCase() as Hex;
}
function block(value: unknown, number: bigint, hash: Hex) {
	if (value === null || typeof value !== 'object' || !('number' in value) || !('hash' in value)
		|| quantity(value.number) !== number || value.hash !== hash) error('CHECKPOINT_MISMATCH');
}

/** Consistency observation of ORIGINAL creation composition. Every state read is pinned
 * with EIP-1898, and unknown code is never interrogated for its own identity first.
 * A successful result is NOT source provenance, an audit, an honest-RPC proof, freshness,
 * finality, bundler conformance, network admission, sponsorship or account readiness.
 * No fallback to current-upgrade manifests, latest, another chain, or a previous success.
 */
export async function inspectCreationDeployment(client: PublicClient, input: CreationInspectionInput) {
	const profile = loadPinnedCreationProfile(input.document, input.expectedDigest);
	const profileDigest = input.expectedDigest, manifest = profile.deployment;
	const checkpoint = Object.freeze({ ...input.checkpoint });
	requireHash(checkpoint.block_hash);
	const height = BigInt(parseAtomicAmount(checkpoint.block_number));
	for (const component of [...Object.values(manifest.components), profile.webauthn_verifier]) {
		if (BigInt(component.deployed_block) > height) throw new Error('Checkpoint predates creation profile');
	}
	const pinned = { blockHash: checkpoint.block_hash, requireCanonical: true } as const;
	const options = { retryCount: 0, dedupe: false } as const;
	const components = manifest.components;
	const slot = toHex(BigInt(keccak256(stringToHex('eip1967.proxy.implementation'))) - 1n, { size: 32 });
	const expectedCode = [
		...Object.values(components).map((item) => ({ address: item.address, hash: item.runtime_code_hash })),
		{ address: manifest.entry_point, hash: profile.entry_point_code_hash },
		{ address: profile.sender_creator.address, hash: profile.sender_creator.runtime_code_hash },
		{ address: profile.webauthn_verifier.address, hash: profile.webauthn_verifier.runtime_code_hash },
	];
	type Getter = typeof creationInspectionAbi[number]['name'];
	async function expectGetter(address: Address, getter: Getter, type: 'address' | 'bytes32', expected: Hex) {
		const result = data(await client.request({ method: 'eth_call', params: [{ to: address, gas: toHex(200_000),
			data: encodeFunctionData({ abi: creationInspectionAbi, functionName: getter }) }, pinned] }, options), 32);
		// Comparing the complete ABI word also rejects padding, trailing bytes and noncanonical results.
		const encoded = type === 'address' ? encodeAbiParameters([{ type: 'address' }], [expected])
			: encodeAbiParameters([{ type: 'bytes32' }], [expected]);
		if (result !== encoded.toLowerCase()) error('COMPOSITION_MISMATCH');
	}
	try {
		if (quantity(await client.request({ method: 'eth_chainId' }, options)) !== evmChainId(manifest.network_id)) error('CHAIN_MISMATCH');
		block(await client.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] }, options), 0n, manifest.genesis_hash);
		block(await client.request({ method: 'eth_getBlockByNumber', params: [toHex(height), false] }, options), height, checkpoint.block_hash);
		for (const expected of expectedCode) {
			const runtime = data(await client.request({ method: 'eth_getCode', params: [expected.address, pinned] }, options), 24576);
			if (runtime === '0x' || keccak256(runtime) !== expected.hash) error('UNEXPECTED_CODE');
		}
		const factory = components.factory.address, implementation = components.implementation.address;
		const expectations: readonly [Address, Getter, 'address' | 'bytes32', Hex][] = [
			[factory, 'implementation', 'address', implementation],
			[factory, 'entryPoint', 'address', manifest.entry_point],
			[factory, 'senderCreator', 'address', profile.sender_creator.address],
			[factory, 'implementationCodeHash', 'bytes32', components.implementation.runtime_code_hash],
			[factory, 'entryPointCodeHash', 'bytes32', profile.entry_point_code_hash],
			[factory, 'senderCreatorCodeHash', 'bytes32', profile.sender_creator.runtime_code_hash],
			[factory, 'securityModuleCodeHash', 'bytes32', components.security_module.runtime_code_hash],
			[factory, 'upgradeModuleCodeHash', 'bytes32', components.upgrade_module.runtime_code_hash],
			[factory, 'proxyInitCodeHash', 'bytes32', manifest.proxy.init_code_hash],
			[manifest.entry_point, 'senderCreator', 'address', profile.sender_creator.address],
			[implementation, 'initializationEntryPoint', 'address', manifest.entry_point],
			[implementation, 'entryPoint', 'address', manifest.entry_point],
			[implementation, 'securityModule', 'address', components.security_module.address],
			[implementation, 'securityModuleCodeHash', 'bytes32', components.security_module.runtime_code_hash],
			[implementation, 'upgradeModule', 'address', components.upgrade_module.address],
			[implementation, 'upgradeModuleCodeHash', 'bytes32', components.upgrade_module.runtime_code_hash],
			[implementation, 'storageLayoutHash', 'bytes32', manifest.storage_layout_hash],
			[implementation, 'proxiableUUID', 'bytes32', slot],
		];
		// Sequential bounded calls avoid orphaned sibling I/O after a Worker request fails.
		for (const expectation of expectations) await expectGetter(...expectation);
		block(await client.request({ method: 'eth_getBlockByNumber', params: [toHex(height), false] }, options), height, checkpoint.block_hash);
		return Object.freeze({ status: 'composition_matches' as const, network_id: manifest.network_id,
			profile_sha256: profileDigest, checkpoint, network_admitted: false as const });
	} catch (reason) {
		if (reason instanceof CreationInspectionError) throw reason;
		throw new CreationInspectionError('RPC_UNAVAILABLE');
	}
}
