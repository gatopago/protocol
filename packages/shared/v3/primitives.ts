/** V3 wire primitives. Never use a Firebase subject or an address as a resource ID. */
export const resourcePrefixes = {
	user: "usr",
	party: "pty",
	wallet: "wal",
	walletAccount: "wac",
	accountIdentity: "aci",
	organization: "org",
	project: "prj",
	customer: "cus",
	settlementAccount: "sta",
	financialAccount: "fac",
	operation: "op",
} as const;

export type ResourceKind = keyof typeof resourcePrefixes;
export type ResourceId<K extends ResourceKind> = `${(typeof resourcePrefixes)[K]}_${string}`;
export type NetworkId = `${string}:${string}`;
export type AtomicAmount = string & { readonly __atomicAmount: unique symbol };

export const UINT256_MAX = (1n << 256n) - 1n;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function parseResourceId<K extends ResourceKind>(kind: K, value: unknown): ResourceId<K> {
	if (typeof value !== "string" || value.trim() !== value || !new RegExp(`^${resourcePrefixes[kind]}_${UUID_V4}$`).test(value)) {
		throw new Error(`Invalid ${kind} resource ID`);
	}
	return value as ResourceId<K>;
}

export function createResourceId<K extends ResourceKind>(kind: K): ResourceId<K> {
	return parseResourceId(kind, `${resourcePrefixes[kind]}_${crypto.randomUUID()}`);
}

export function parseAtomicAmount(value: unknown): AtomicAmount {
	if (typeof value !== "string" || value.trim() !== value || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT256_MAX) {
		throw new Error("Amount must be a canonical uint256 decimal string");
	}
	return value as AtomicAmount;
}

/** Representation is rail-neutral; accepting an ID does not enable that rail. */
export function parseNetworkId(value: unknown): NetworkId {
	if (typeof value !== "string" || value.trim() !== value || !/^[a-z0-9-]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(value)) {
		throw new Error("Invalid CAIP-2 network ID");
	}
	if (value.startsWith("eip155:") && !/^eip155:[1-9][0-9]{0,31}$/.test(value)) {
		throw new Error("EVM chain ID must be a positive canonical integer");
	}
	return value as NetworkId;
}

export function evmChainId(value: unknown): bigint {
	const id = parseNetworkId(value);
	if (!id.startsWith("eip155:")) throw new Error("Unsupported execution ecosystem");
	return BigInt(id.slice(7));
}

/** Case-normalized wire identity, not unverified token metadata or a ticker. */
export function parseEvmAssetId(value: unknown): string {
	if (typeof value !== "string" || value.trim() !== value) throw new Error("Invalid asset ID");
	const parts = value.split("/");
	evmChainId(parts[0]);
	const asset = parts[1] ?? "";
	if (/^slip44:(0|[1-9][0-9]{0,9})$/.test(asset) && parts.length === 2) return value;
	if (/^erc20:0x[0-9a-f]{40}$/.test(asset) && parts.length === 2) return value;
	if (/^erc(721|1155):0x[0-9a-f]{40}$/.test(asset) && parts.length === 3) {
		parseAtomicAmount(parts[2]);
		return value;
	}
	throw new Error("Invalid or non-canonical EVM asset ID");
}

export function assertAssetNetwork(assetId: string, networkId: NetworkId): void {
	if (parseEvmAssetId(assetId).split("/")[0] !== parseNetworkId(networkId)) {
		throw new Error("Asset and operation networks differ");
	}
}
