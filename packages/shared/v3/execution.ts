import { encodeAbiParameters, encodeFunctionData, isAddressEqual, parseAbi, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { authorizationTypes, hashCalls, type AccountCall, type ExecutionPlan } from "./authorizations";

/** Internal candidate ABI; not a declaration that an Account V3 deployment/API is available. */
export const executionAbi = parseAbi([
	"struct Call { address target; uint256 value; bytes data; }",
	"struct Signature { uint8 signerIndex; bytes signature; }",
	"struct ExecutionPlan { bytes32 accountId; uint32 generation; uint64 securityVersion; uint8 executionMode; address entryPoint; bytes32 userOpHash; bytes32 callsHash; bytes32 assetLimitsHash; bytes32 feePolicyHash; address paymaster; bytes32 previewHash; uint256 nonce; uint48 validAfter; uint48 validUntil; }",
	"function execute(Call[] calls, uint64 expectedSecurityVersion)",
	"function executeSigned(Call[] calls, ExecutionPlan plan, Signature[] signatures)",
	"function completeCreation()",
	"function directNonce() view returns (uint256)",
	"function securityVersion() view returns (uint64)",
]);

export type ExecutionSignature = { signerIndex: number; signature: Hex };

function checkCalls(account: Address, calls: readonly AccountCall[]): void {
	hashCalls(calls); // Canonical encoding and 1..32 batch bound.
	if (calls.some((call) => isAddressEqual(call.target, zeroAddress) || isAddressEqual(call.target, account))) {
		throw new Error("Account security operations cannot be nested in a spend batch");
	}
}

export function encodeAccountExecution(account: Address, calls: readonly AccountCall[], securityVersion: bigint): Hex {
	checkCalls(account, calls);
	if (securityVersion <= 0n) throw new Error("Invalid security version");
	return encodeFunctionData({ abi: executionAbi, functionName: "execute", args: [calls, securityVersion] });
}

export function encodeDirectExecution(account: Address, calls: readonly AccountCall[], plan: ExecutionPlan, signatures: readonly ExecutionSignature[]): Hex {
	checkCalls(account, calls);
	if (plan.generation !== 3 || plan.securityVersion <= 0n || plan.executionMode !== 1
		|| !isAddressEqual(plan.entryPoint, zeroAddress) || plan.userOpHash !== zeroHash
		|| !isAddressEqual(plan.paymaster, zeroAddress) || plan.callsHash !== hashCalls(calls)
		|| plan.validAfter <= 0 || plan.validUntil <= plan.validAfter || plan.validUntil > 0x7fffffffffff) {
		throw new Error("Invalid direct execution plan");
	}
	return encodeFunctionData({ abi: executionAbi, functionName: "executeSigned", args: [calls, plan, signatures] });
}

/** UserOp hash excludes this envelope. Never embed the signed plan into UserOp.callData. */
export function encodeExecutionSignature(plan: ExecutionPlan, signatures: readonly ExecutionSignature[]): Hex {
	return encodeAbiParameters([
		{ type: "tuple", components: authorizationTypes.ExecutionPlan },
		{ type: "tuple[]", components: [{ name: "signerIndex", type: "uint8" }, { name: "signature", type: "bytes" }] },
	], [plan, signatures]);
}
