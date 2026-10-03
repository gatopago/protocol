import { decodeEventLog, encodeAbiParameters, encodeEventTopics, isAddress, isAddressEqual, keccak256, parseAbi, toHex,
	zeroHash, type Address, type Hex, type PublicClient } from 'viem';
import { hashSecurityManifest } from './authorizations';
import type { authorizeCreationOperation } from './creationOperation';
import { inspectCreationDeployment } from './creationInspection';
import { requireHash } from './deployment';
import { loadPinnedCreationProfile } from './initialization';

type SignedCreation = ReturnType<typeof authorizeCreationOperation>;
type Row = Record<string, unknown>;
export const creationReceiptAbi = parseAbi([
	'event AccountInitialized(bytes32 indexed accountId, bytes32 manifestHash, bytes32 approvalDigest)',
	'event AccountCreated(bytes32 indexed accountId, address indexed account, bytes32 initialSecurityCommitment)',
	'event AccountDeployed(bytes32 indexed userOpHash, address indexed sender, address factory, address paymaster)',
	'event CreationCompleted()',
	'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
type EventName = typeof creationReceiptAbi[number]['name'];
class ReceiptError extends Error {
	constructor(readonly code: 'INVALID_CREATION_RECEIPT' | 'CREATION_EVENT_MISMATCH' | 'CREATION_BLOCK_CHANGED' | 'CREATION_RPC_UNAVAILABLE') {
		super(code); this.name = 'CreationReceiptError';
	}
}
function row(value: unknown): Row {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReceiptError('INVALID_CREATION_RECEIPT');
	return value as Row;
}
function quantity(value: unknown): bigint {
	if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$(?![\s\S])/.test(value)) throw new ReceiptError('INVALID_CREATION_RECEIPT');
	return BigInt(value);
}
function hash(value: unknown): Hex { requireHash(value); return value; }
function address(value: unknown): Address {
	if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new ReceiptError('INVALID_CREATION_RECEIPT');
	return value.toLowerCase() as Address;
}
function bytes(value: unknown, limit: number): Hex {
	if (typeof value !== 'string' || value.length > limit * 2 + 2 || !/^0x(?:[0-9a-fA-F]{2})*$(?![\s\S])/.test(value)) throw new ReceiptError('INVALID_CREATION_RECEIPT');
	return value.toLowerCase() as Hex;
}
function topic(value: unknown): Hex {
	const result = bytes(value, 32);
	if (result.length !== 66) throw new ReceiptError('INVALID_CREATION_RECEIPT');
	return result;
}

/** Strict economic/event evidence for ONE immutable creation grant. Accept raw execution
 * RPC receipts, never a bundler's summary. This alone proves neither RPC honesty nor
 * canonicality/finality, current security policy, activation or spend readiness.
 * The caller must restore/verify the signed grant before passing it here.
 */
export function verifyCreationReceipt(signed: SignedCreation, transactionHash: Hex, value: unknown) {
	try {
		requireHash(transactionHash);
		const receipt = row(value);
		if (receipt.status !== '0x1' || hash(receipt.transactionHash) !== transactionHash) throw new ReceiptError('CREATION_EVENT_MISMATCH');
		const blockHash = hash(receipt.blockHash), blockNumber = quantity(receipt.blockNumber), transactionIndex = quantity(receipt.transactionIndex);
		if (!Array.isArray(receipt.logs) || receipt.logs.length > 2048) throw new ReceiptError('INVALID_CREATION_RECEIPT');
		let previousIndex = -1n;
		const logs = receipt.logs.map((value: unknown) => {
			const log = row(value), index = quantity(log.logIndex);
			if (hash(log.transactionHash) !== transactionHash || hash(log.blockHash) !== blockHash
				|| quantity(log.blockNumber) !== blockNumber || quantity(log.transactionIndex) !== transactionIndex
				|| log.removed !== false || index <= previousIndex || !Array.isArray(log.topics) || log.topics.length > 4) throw new ReceiptError('INVALID_CREATION_RECEIPT');
			previousIndex = index;
			return { address: address(log.address), data: bytes(log.data, 65_536), topics: log.topics.map(topic), index };
		});
		const prepared = signed.prepared, account = signed.operation.sender, ep = prepared.message.entryPoint, factory = prepared.message.factory;
		function event(name: EventName, emitter: Address, indexed?: Hex, optional = false) {
			const topic = encodeEventTopics({ abi: creationReceiptAbi, eventName: name })[0];
			const matches = logs.filter((log) => isAddressEqual(log.address, emitter) && log.topics[0] === topic
				&& (indexed === undefined || log.topics[1] === indexed));
			if (optional && matches.length === 0) return null;
			if (matches.length !== 1) throw new ReceiptError('CREATION_EVENT_MISMATCH');
			const log = matches[0];
			const topicCounts = { AccountInitialized: 2, AccountCreated: 3, AccountDeployed: 3, CreationCompleted: 1, UserOperationEvent: 4 } as const;
			if (log.topics.length !== topicCounts[name]) throw new ReceiptError('INVALID_CREATION_RECEIPT');
			const decoded = decodeEventLog({ abi: creationReceiptAbi, eventName: name, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
			return { ...log, decoded };
		}
		const initialized = event('AccountInitialized', account, prepared.message.accountId)!;
		const created = event('AccountCreated', factory, prepared.message.accountId)!;
		const deployed = event('AccountDeployed', ep, signed.userOpHash)!;
		const operation = event('UserOperationEvent', ep, signed.userOpHash)!;
		const completed = event('CreationCompleted', account, undefined, true);
		// Explicit event narrowing also protects the typed decoder against future ABI changes.
		if (initialized.decoded.eventName !== 'AccountInitialized' || created.decoded.eventName !== 'AccountCreated'
			|| deployed.decoded.eventName !== 'AccountDeployed' || operation.decoded.eventName !== 'UserOperationEvent') throw new ReceiptError('CREATION_EVENT_MISMATCH');
		const manifestHash = hashSecurityManifest({ accountId: prepared.message.accountId, generation: 3, securityVersion: 1n,
			previousManifestHash: zeroHash, policyHash: prepared.message.initialSecurityCommitment, chainScopeHash: prepared.message.chainScopeHash });
		const init = initialized.decoded.args, creation = created.decoded.args, deployment = deployed.decoded.args, outcome = operation.decoded.args;
		const accountTopic = encodeAbiParameters([{ type: 'address' }], [account]);
		if (init.manifestHash !== manifestHash || init.approvalDigest !== prepared.digest
			|| created.topics[2] !== accountTopic || deployed.topics[2] !== accountTopic || operation.topics[2] !== accountTopic || operation.topics[3] !== encodeAbiParameters([{ type: 'address' }], [signed.plan.paymaster])
			|| !isAddressEqual(creation.account, account) || creation.initialSecurityCommitment !== prepared.message.initialSecurityCommitment
			|| !isAddressEqual(deployment.sender, account) || !isAddressEqual(deployment.factory, factory) || !isAddressEqual(deployment.paymaster, signed.plan.paymaster)
			|| !isAddressEqual(outcome.sender, account) || !isAddressEqual(outcome.paymaster, signed.plan.paymaster) || outcome.nonce !== signed.operation.nonce
			|| outcome.actualGasCost > signed.maximumEntryPointCharge || outcome.actualGasUsed === 0n
			|| initialized.index >= created.index || created.index >= deployed.index || deployed.index >= operation.index
			|| outcome.success !== (completed !== null) || (completed && (completed.index <= deployed.index || completed.index >= operation.index))) throw new ReceiptError('CREATION_EVENT_MISMATCH');
		// decodeEventLog accepts trailing ABI bytes in some cases. Require exact canonical
		// data for the events that establish authority or an economic outcome.
		if (initialized.data !== encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [manifestHash, prepared.digest])
			|| created.data !== prepared.message.initialSecurityCommitment
			|| deployed.data !== encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [factory, signed.plan.paymaster])
			|| operation.data !== encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
				[outcome.nonce, outcome.success, outcome.actualGasCost, outcome.actualGasUsed]) || (completed && completed.data !== '0x')) throw new ReceiptError('INVALID_CREATION_RECEIPT');
		return Object.freeze({ schema_version: 1 as const, network_id: prepared.profile.deployment.network_id,
			profile_sha256: prepared.profileDigest, user_op_hash: signed.userOpHash, transaction_hash: transactionHash,
			block_hash: blockHash, block_number: blockNumber.toString(), transaction_index: transactionIndex.toString(),
			account: account.toLowerCase() as Address, entry_point: ep.toLowerCase() as Address,
			outcome: outcome.success ? 'creation_succeeded' as const : 'execution_reverted' as const,
			actual_gas_cost: outcome.actualGasCost.toString(), actual_gas_used: outcome.actualGasUsed.toString(), initial_manifest_hash: manifestHash,
			log_indexes: Object.freeze({ initialized: initialized.index.toString(), created: created.index.toString(), deployed: deployed.index.toString(),
				completed: completed?.index.toString() ?? null, operation: operation.index.toString() }),
			finality: 'not_assessed' as const, account_readiness: 'not_assessed' as const });
	} catch (error) {
		if (error instanceof ReceiptError) throw error;
		throw new ReceiptError('INVALID_CREATION_RECEIPT');
	}
}

/** Independent execution-RPC observation at the receipt's canonical block. A missing or
 * orphaned receipt NEVER permits rebroadcast. The caller supplies a bounded transport,
 * must compare independent providers, and apply chain-specific finality before promotion.
 */
export async function observeCreationReceipt(client: PublicClient, signed: SignedCreation, transactionHash: Hex, profileDocument: string) {
	const options = { dedupe: false, retryCount: 0 } as const;
	try {
		requireHash(transactionHash);
		loadPinnedCreationProfile(profileDocument, signed.prepared.profileDigest);
		const raw = await client.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] }, options);
		if (raw === null) return null;
		const observation = verifyCreationReceipt(signed, transactionHash, raw);
		const checkpoint = { block_hash: observation.block_hash, block_number: observation.block_number };
		await inspectCreationDeployment(client, { document: profileDocument, expectedDigest: signed.prepared.profileDigest, checkpoint });
		const block = row(await client.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(observation.block_number)), false] }, options));
		const time = quantity(block.timestamp);
		if (hash(block.hash) !== observation.block_hash || quantity(block.number) !== BigInt(observation.block_number)
			|| time < BigInt(signed.prepared.message.validAfter) || time > BigInt(signed.prepared.message.validUntil)) throw new ReceiptError('CREATION_BLOCK_CHANGED');
		const code = bytes(await client.request({ method: 'eth_getCode', params: [signed.operation.sender,
			{ blockHash: observation.block_hash, requireCanonical: true }] }, options), 24_576);
		if (keccak256(code) !== signed.prepared.profile.deployment.proxy.runtime_code_hash) throw new ReceiptError('CREATION_EVENT_MISMATCH');
		// End by checking the receipt's block again, rather than trusting a cached height.
		const end = row(await client.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(observation.block_number)), false] }, options));
		if (hash(end.hash) !== observation.block_hash || quantity(end.number) !== BigInt(observation.block_number)
			|| quantity(end.timestamp) !== time) throw new ReceiptError('CREATION_BLOCK_CHANGED');
		return Object.freeze({ ...observation, block_timestamp: time.toString() });
	} catch (error) {
		if (error instanceof ReceiptError) throw error;
		throw new ReceiptError('CREATION_RPC_UNAVAILABLE');
	}
}
