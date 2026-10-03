import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, isAddressEqual, keccak256, parseAbi,
	toHex, type Address, type Hex, type PublicClient } from "viem";
import { deriveAccountId, predictAccountAddress } from "./authorizations";
import { loadPinnedDeploymentManifest, requireHash } from "./deployment";
import { evmChainId, parseAtomicAmount } from "./primitives";

export const accountInspectionAbi = parseAbi([
	"struct ImplementationExpectation { address implementation; bytes32 runtimeCodeHash; bytes32 storageLayoutHash; address securityModule; bytes32 securityModuleCodeHash; address upgradeModule; bytes32 upgradeModuleCodeHash; }",
	"struct AccountInspection { address account; bytes32 accountId; address implementation; uint64 securityVersion; bytes32 storageLayoutHash; }",
	"function inspectAccount(bytes32 initialSecurityCommitment, bytes32 userSaltCommitment, ImplementationExpectation expected) view returns (AccountInspection observation)",
	"function proxyInitCodeHash() view returns (bytes32)",
	"function entryPoint() view returns (address)",
	"function proxyImplementation() view returns (address)",
]);

export interface InspectionCheckpoint {
	readonly block_hash: Hex;
	readonly block_number: string;
}

export interface AccountInspectionInput {
	readonly document: string;
	/** Out-of-band admitted pin, not supplied by an untrusted account visitor. */
	readonly expectedDigest: Hex;
	readonly initialSecurityCommitment: Hex;
	readonly userSaltCommitment: Hex;
	/** Chosen by the caller's chain/finality policy. This helper does not choose "latest". */
	readonly checkpoint: InspectionCheckpoint;
}

export type InspectionErrorCode = "CHAIN_MISMATCH" | "CHECKPOINT_MISMATCH" | "INVALID_RPC_DATA"
	| "UNEXPECTED_CODE" | "UNEXPECTED_IMPLEMENTATION" | "IDENTITY_MISMATCH" | "RPC_UNAVAILABLE";
export class AccountInspectionError extends Error {
	constructor(readonly code: InspectionErrorCode) { super(code); this.name = "AccountInspectionError"; }
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quantity(value: unknown): bigint {
	if (typeof value !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$(?![\s\S])/.test(value)) throw new AccountInspectionError("INVALID_RPC_DATA");
	return BigInt(value);
}

function bytes(value: unknown, maxBytes: number): Hex {
	if (typeof value !== "string" || value.length > 2 + 2 * maxBytes || !/^0x([0-9a-fA-F]{2})*$(?![\s\S])/.test(value)) {
		throw new AccountInspectionError("INVALID_RPC_DATA");
	}
	return value.toLowerCase() as Hex;
}

function checkBlock(value: unknown, number: bigint, hash: Hex): void {
	if (!record(value) || quantity(value.number) !== number || value.hash !== hash) throw new AccountInspectionError("CHECKPOINT_MISMATCH");
}

/** Read-only revision inspection, usable by Wallet Core and an independent portable client.
 * EIP-1898 hashes pin EVERY state read. No latest/height fallback when a provider does not
 * support them. No multicall contract, global cache, polling, mutation or creation attempt.
 * The returned observation is NOT proof of finality, spend-readiness or honest RPC execution.
 * Callers must use bounded request-scoped transports and independent network observations.
 */
export async function inspectAccountDeployment(client: PublicClient, input: AccountInspectionInput) {
	// Validate and detach all inputs before the first asynchronous boundary (no TOCTOU mutation).
	const manifest = loadPinnedDeploymentManifest(input.document, input.expectedDigest);
	if (manifest.lifecycle_status !== "deployed") throw new Error("Deployment profile is not deployed");
	const { initialSecurityCommitment, userSaltCommitment, expectedDigest } = input;
	requireHash(initialSecurityCommitment);
	requireHash(userSaltCommitment);
	const checkpoint = Object.freeze({ ...input.checkpoint });
	requireHash(checkpoint.block_hash);
	const number = BigInt(parseAtomicAmount(checkpoint.block_number));
	const components = manifest.components;
	for (const component of Object.values(components)) {
		if (BigInt(component.deployed_block) > number) throw new Error("Checkpoint predates deployment profile");
	}
	const accountId = deriveAccountId(initialSecurityCommitment, userSaltCommitment);
	const account = predictAccountAddress(components.factory.address, accountId, manifest.proxy.init_code_hash);
	const block = { blockHash: checkpoint.block_hash, requireCanonical: true } as const;
	const requestOptions = { dedupe: false, retryCount: 0 } as const;
	const base = { account, account_id: accountId, network_id: manifest.network_id,
		manifest_id: manifest.manifest_id, manifest_sha256: expectedDigest, checkpoint,
		spend_readiness: "not_assessed" as const };

	async function code(address: Address) {
		return bytes(await client.request({ method: "eth_getCode", params: [address, block] }, requestOptions), 24_576);
	}
	async function requireCode(address: Address, expectedHash: Hex) {
		const runtime = await code(address);
		if (runtime === "0x" || keccak256(runtime) !== expectedHash) throw new AccountInspectionError("UNEXPECTED_CODE");
	}
	async function call(to: Address, data: Hex, resultBytes: number) {
		// Explicit bound on eth_call gas too: unknown RPC failure must not become an activation flow.
		const result = bytes(await client.request({ method: "eth_call", params: [{ to, data, gas: toHex(1_000_000) }, block] }, requestOptions), resultBytes);
		if (result.length !== 2 + resultBytes * 2) throw new AccountInspectionError("INVALID_RPC_DATA");
		return result;
	}
	async function checkCheckpoint() {
		checkBlock(await client.request({ method: "eth_getBlockByNumber", params: [toHex(number), false] }, requestOptions), number, checkpoint.block_hash);
	}
	try {
		if (quantity(await client.request({ method: "eth_chainId" }, requestOptions)) !== evmChainId(manifest.network_id)) throw new AccountInspectionError("CHAIN_MISMATCH");
		checkBlock(await client.request({ method: "eth_getBlockByNumber", params: ["0x0", false] }, requestOptions), 0n, manifest.genesis_hash);
		await checkCheckpoint();
		await requireCode(components.factory.address, components.factory.runtime_code_hash);
		const initCodeHash = decodeFunctionResult({ abi: accountInspectionAbi, functionName: "proxyInitCodeHash",
			data: await call(components.factory.address, encodeFunctionData({ abi: accountInspectionAbi, functionName: "proxyInitCodeHash" }), 32) });
		const entryPoint = decodeFunctionResult({ abi: accountInspectionAbi, functionName: "entryPoint",
			data: await call(components.factory.address, encodeFunctionData({ abi: accountInspectionAbi, functionName: "entryPoint" }), 32) });
		if (initCodeHash !== manifest.proxy.init_code_hash || !isAddressEqual(entryPoint, manifest.entry_point)) throw new AccountInspectionError("IDENTITY_MISMATCH");
		const proxyRuntime = await code(account);
		if (proxyRuntime === "0x") {
			await checkCheckpoint();
			return { ...base, status: "not_deployed" as const };
		}
		if (keccak256(proxyRuntime) !== manifest.proxy.runtime_code_hash) throw new AccountInspectionError("UNEXPECTED_CODE");
		// This selector is NONDELEGATED in the pinned proxy. Never interrogate an unknown target.
		const targetData = await call(account, encodeFunctionData({ abi: accountInspectionAbi, functionName: "proxyImplementation" }), 32);
		const target = decodeFunctionResult({ abi: accountInspectionAbi, functionName: "proxyImplementation", data: targetData });
		if (encodeFunctionResult({ abi: accountInspectionAbi, functionName: "proxyImplementation", result: target }) !== targetData) throw new AccountInspectionError("INVALID_RPC_DATA");
		if (!isAddressEqual(target, components.implementation.address)) throw new AccountInspectionError("UNEXPECTED_IMPLEMENTATION");
		// Await each operation: no orphaned sibling I/O if a dependency fails inside a Worker.
		for (const component of [components.implementation, components.security_module, components.upgrade_module]) {
			await requireCode(component.address, component.runtime_code_hash);
		}
		const expected = { implementation: components.implementation.address, runtimeCodeHash: components.implementation.runtime_code_hash,
			storageLayoutHash: manifest.storage_layout_hash, securityModule: components.security_module.address,
			securityModuleCodeHash: components.security_module.runtime_code_hash, upgradeModule: components.upgrade_module.address,
			upgradeModuleCodeHash: components.upgrade_module.runtime_code_hash };
		const result = await call(components.factory.address, encodeFunctionData({ abi: accountInspectionAbi, functionName: "inspectAccount",
			args: [initialSecurityCommitment, userSaltCommitment, expected] }), 160);
		const observation = decodeFunctionResult({ abi: accountInspectionAbi, functionName: "inspectAccount", data: result });
		if (encodeFunctionResult({ abi: accountInspectionAbi, functionName: "inspectAccount", result: observation }) !== result
			|| !isAddressEqual(observation.account, account) || observation.accountId !== accountId
			|| !isAddressEqual(observation.implementation, target) || observation.storageLayoutHash !== manifest.storage_layout_hash
			|| observation.securityVersion === 0n) throw new AccountInspectionError("IDENTITY_MISMATCH");
		await checkCheckpoint();
		return { ...base, status: "recognized" as const, implementation: target,
			security_version: observation.securityVersion.toString(), storage_layout_hash: observation.storageLayoutHash };
	} catch (error) {
		if (error instanceof AccountInspectionError) throw error;
		// Do not expose upstream URLs, credentials, revert payloads or viem request diagnostics.
		throw new AccountInspectionError("RPC_UNAVAILABLE");
	}
}
