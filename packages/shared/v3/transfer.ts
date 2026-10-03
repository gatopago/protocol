import { validateTransferShape } from "./wire-validators.mjs";
import { assertAssetNetwork, parseAtomicAmount, type NetworkId, type ResourceId } from "./primitives";

export interface TransferRequest {
	schema_version: 1;
	generation: 3;
	wallet_id: ResourceId<"wallet">;
	network_id: NetworkId;
	asset_id: string;
	destination: { address: `0x${string}`; address_type: "evm_eoa" | "evm_contract" | "evm_unknown" };
	amount: { kind: "exact"; amount_atomic: string } | { kind: "max" };
	client_release_id: string;
}

/** A parsed request is not consent, ownership proof, a quote or an execution plan. */
export function parseTransferRequest(input: unknown): TransferRequest {
	if (!validateTransferShape(input)) throw new Error("Invalid V3 transfer request");
	const request = input as TransferRequest;
	assertAssetNetwork(request.asset_id, request.network_id);
	if (request.destination.address === `0x${"0".repeat(40)}`) throw new Error("Zero destination is not a consumer transfer");
	if (request.amount.kind === "exact" && BigInt(parseAtomicAmount(request.amount.amount_atomic)) === 0n) {
		throw new Error("Transfer amount must be positive");
	}
	return structuredClone(request);
}

/** Resolve MAX against an observed block; no float, rounding, or hidden fee subtraction. */
export function resolveMaxTransfer(balance: string, nativeAsset: boolean, maximumGasCost: string, platformFee: string): string {
	if (typeof nativeAsset !== 'boolean') throw new Error('Asset kind must be explicit');
	const available = BigInt(parseAtomicAmount(balance));
	const gas = BigInt(parseAtomicAmount(maximumGasCost));
	const fee = BigInt(parseAtomicAmount(platformFee));
	// platformFee is explicitly in this transfer asset; native gas is another balance for ERC20.
	const reserved = fee + (nativeAsset ? gas : 0n);
	if (available <= reserved) throw new Error("Insufficient balance after bounded costs");
	return (available - reserved).toString();
}

/** Internal funding calculation, NOT a quote, balance reader or authorization.
 * Caller must independently verify ownership, asset metadata, block/finality,
 * reservations and fee policy before supplying this account-specific budget.
 * Gas is the maximum payable by this account (zero only for verified sponsorship).
 */
export function resolveTransferFunding(input: TransferRequest, budget: {
	wallet_id: ResourceId<'wallet'>;
	asset_id: string;
	asset_available_atomic: string;
	native_available_atomic: string;
	maximum_native_gas_atomic: string;
	platform_fee: { asset_id: string; amount_atomic: string };
}): { amount_atomic: string; asset_debit_atomic: string; native_remaining_atomic: string } {
	const request = parseTransferRequest(input);
	if (request.wallet_id !== budget.wallet_id || request.asset_id !== budget.asset_id
		|| budget.platform_fee.asset_id !== request.asset_id) throw new Error('Funding context mismatch');
	const assetKind = request.asset_id.split('/')[1];
	const native = assetKind.startsWith('slip44:');
	if (!native && !assetKind.startsWith('erc20:')) throw new Error('Fungible transfer required');
	const available = BigInt(parseAtomicAmount(budget.asset_available_atomic));
	const nativeAvailable = BigInt(parseAtomicAmount(budget.native_available_atomic));
	const gas = BigInt(parseAtomicAmount(budget.maximum_native_gas_atomic));
	const fee = BigInt(parseAtomicAmount(budget.platform_fee.amount_atomic));
	if (native && available !== nativeAvailable) throw new Error('Conflicting native balances');
	if (nativeAvailable < gas) throw new Error('Insufficient native gas balance');
	const amount = request.amount.kind === 'max'
		? BigInt(resolveMaxTransfer(available.toString(), native, gas.toString(), fee.toString()))
		: BigInt(request.amount.amount_atomic);
	const debit = amount + fee + (native ? gas : 0n);
	if (debit > available) throw new Error('Insufficient asset balance after bounded costs');
	return { amount_atomic: amount.toString(), asset_debit_atomic: debit.toString(),
		native_remaining_atomic: (nativeAvailable - gas - (native ? amount + fee : 0n)).toString() };
}
