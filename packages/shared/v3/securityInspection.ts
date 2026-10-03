import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex, zeroHash,
	type Address, type Hex, type PublicClient } from 'viem';
import { AccountInspectionError, inspectAccountDeployment, type AccountInspectionInput } from './accountInspection';
import { hashSecurityManifest } from './authorizations';
import { hashSecurityPolicy, SignerKind, type SecurityPolicy } from './securityPolicy';

export const accountSecurityInspectionAbi = parseAbi([
	'struct SignerDescriptor { uint8 kind; address verifier; bytes32 verifierCodeHash; bytes key; uint8 roles; }',
	'struct SecurityPolicy { uint8 mode; SignerDescriptor[] signers; uint16 spendThreshold; uint16 adminThreshold; uint48 upgradeDelaySeconds; }',
	'function securitySnapshot() view returns (uint256[16] snapshot)',
	'function securityPolicy() view returns (SecurityPolicy policy)',
]);

function bytes(value: unknown, maxBytes: number): Hex {
	if (typeof value !== 'string' || value.length > 2 + maxBytes * 2 || !/^0x(?:[0-9a-fA-F]{2})*$(?![\s\S])/.test(value)) {
		throw new AccountInspectionError('INVALID_RPC_DATA');
	}
	return value.toLowerCase() as Hex;
}

/** Observes CURRENT policy at an explicit checkpoint, not the original initialization receipt.
 * Shared by Wallet Core and portable readers. No login, storage writes, signing or implicit
 * expiry/activation. Recognized policy is NOT factor possession, finality or spend permission.
 * The caller supplies a bounded transport, independent observations and a fresh admitted pin.
 */
export async function inspectAccountSecurity(client: PublicClient, input: AccountInspectionInput) {
	const snapshotInput = Object.freeze({ ...input, checkpoint: Object.freeze({ ...input.checkpoint }) });
	// Verify the nondelegated proxy target and every current module BEFORE calling its getters.
	const deployment = await inspectAccountDeployment(client, snapshotInput);
	if (deployment.status === 'not_deployed') return deployment;
	const block = { blockHash: snapshotInput.checkpoint.block_hash, requireCanonical: true } as const;
	const options = { retryCount: 0, dedupe: false } as const;
	async function call(functionName: 'securitySnapshot' | 'securityPolicy', maxBytes: number) {
		return bytes(await client.request({ method: 'eth_call', params: [{ to: deployment.account,
			data: encodeFunctionData({ abi: accountSecurityInspectionAbi, functionName }), gas: toHex(1_000_000) }, block] }, options), maxBytes);
	}
	try {
		const encoded = await call('securitySnapshot', 16 * 32);
		const words = decodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: 'securitySnapshot', data: encoded });
		if (encodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: 'securitySnapshot', result: words }) !== encoded) {
			throw new AccountInspectionError('INVALID_RPC_DATA');
		}
		// Fixed public wire schema, not a dependency on Solidity's packed storage offsets.
		const state = { flags: words[0], securityVersion: words[1], manifestHash: toHex(words[2], { size: 32 }),
			chainScopeHash: toHex(words[3], { size: 32 }), creationValidAfter: words[4], creationValidUntil: words[5],
			spendNonce: words[6], adminNonce: words[7], wireRevision: words[8], pendingKind: words[9], pendingHash: toHex(words[10], { size: 32 }),
			pendingVersion: words[11], pendingPreviousManifestHash: toHex(words[12], { size: 32 }), pendingChainScopeHash: toHex(words[13], { size: 32 }),
			pendingReadyAt: words[14], pendingValidUntil: words[15] };
		if ((state.flags & 1n) !== 1n || state.flags > 7n || state.wireRevision !== 1n
			|| state.securityVersion.toString() !== deployment.security_version || state.manifestHash === zeroHash || state.chainScopeHash === zeroHash
			|| (state.flags & 4n) !== 0n || state.pendingKind > 2n || state.securityVersion >= 2n ** 64n || state.pendingVersion >= 2n ** 64n
			|| [state.creationValidAfter, state.creationValidUntil, state.pendingReadyAt, state.pendingValidUntil].some((value) => value >= 2n ** 48n)
			|| (state.creationValidUntil === 0n ? state.creationValidAfter !== 0n : state.creationValidUntil <= state.creationValidAfter)) {
			throw new AccountInspectionError('IDENTITY_MISMATCH');
		}
		if (state.pendingKind === 0n) {
			if (state.pendingHash !== zeroHash || state.pendingVersion !== 0n || state.pendingPreviousManifestHash !== zeroHash
				|| state.pendingChainScopeHash !== zeroHash || state.pendingReadyAt !== 0n || state.pendingValidUntil !== 0n) {
				throw new AccountInspectionError('IDENTITY_MISMATCH');
			}
		} else if (state.pendingHash === zeroHash || state.pendingVersion !== state.securityVersion
			|| state.pendingPreviousManifestHash !== state.manifestHash || state.pendingChainScopeHash === zeroHash
			|| state.pendingReadyAt >= state.pendingValidUntil || state.creationValidUntil !== 0n) {
			throw new AccountInspectionError('IDENTITY_MISMATCH');
		}
		// Top-level offset + policy header + array length + <=16 offsets/signers/128-byte keys.
		const encodedPolicy = await call('securityPolicy', 6432);
		const raw = decodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: 'securityPolicy', data: encodedPolicy });
		if (encodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: 'securityPolicy', result: raw }) !== encodedPolicy
			|| raw.mode !== 1) throw new AccountInspectionError('INVALID_RPC_DATA');
		const policy: SecurityPolicy = { ...raw, mode: 'active',
			signers: raw.signers.map((signer) => {
				if (signer.kind !== 0 && signer.kind !== 1 && signer.kind !== 2) throw new AccountInspectionError('INVALID_RPC_DATA');
				return { ...signer, kind: signer.kind, verifier: signer.verifier.toLowerCase() as Address };
			}) };
		const policyHash = hashSecurityPolicy(policy);
		if (state.pendingKind === 2n && (state.flags & 2n) !== 0n) throw new AccountInspectionError('IDENTITY_MISMATCH');
		if (state.securityVersion === 1n && (policyHash !== snapshotInput.initialSecurityCommitment
			|| state.manifestHash !== hashSecurityManifest({ accountId: deployment.account_id, generation: 3, securityVersion: 1n,
				previousManifestHash: zeroHash, policyHash, chainScopeHash: state.chainScopeHash }))) {
			throw new AccountInspectionError('IDENTITY_MISMATCH');
		}
		// Policy claims alone cannot establish that its contract validators still have pinned code.
		const checked = new Map<Address, Hex>();
		for (const signer of policy.signers) {
			if (signer.kind === SignerKind.ECDSA) continue;
			if (!checked.has(signer.verifier)) {
				const code = bytes(await client.request({ method: 'eth_getCode', params: [signer.verifier, block] }, options), 24_576);
				if (code === '0x') throw new AccountInspectionError('UNEXPECTED_CODE');
				checked.set(signer.verifier, keccak256(code));
			}
			if (checked.get(signer.verifier) !== signer.verifierCodeHash) throw new AccountInspectionError('UNEXPECTED_CODE');
		}
		const closing: unknown = await client.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(deployment.checkpoint.block_number)), false] }, options);
		if (closing === null || typeof closing !== 'object' || !('hash' in closing) || !('number' in closing)
			|| closing.hash !== deployment.checkpoint.block_hash || closing.number !== toHex(BigInt(deployment.checkpoint.block_number))) {
			throw new AccountInspectionError('CHECKPOINT_MISMATCH');
		}
		// Expired proposals remain pending until explicitly cleared onchain. Never infer cancellation.
		const phase = state.creationValidUntil !== 0n ? 'creation_pending' : 'active_policy';
		return { ...deployment, security: { phase, manifest_hash: state.manifestHash, chain_scope_hash: state.chainScopeHash,
			policy_hash: policyHash, policy, upgrades_frozen: (state.flags & 2n) !== 0n,
			creation_valid_after: Number(state.creationValidAfter), creation_valid_until: Number(state.creationValidUntil),
			nonces: { spend: state.spendNonce.toString(), admin: state.adminNonce.toString() },
			pending: state.pendingKind === 0n ? null : { kind: Number(state.pendingKind), hash: state.pendingHash,
				security_version: state.pendingVersion.toString(), previous_manifest_hash: state.pendingPreviousManifestHash,
				chain_scope_hash: state.pendingChainScopeHash, ready_at: Number(state.pendingReadyAt), valid_until: Number(state.pendingValidUntil) } } };
	} catch (error) {
		if (error instanceof AccountInspectionError) throw error;
		// Canonical shape errors and RPC errors both fail closed; never leak provider diagnostics.
		throw new AccountInspectionError('RPC_UNAVAILABLE');
	}
}
