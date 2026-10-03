import { decodeFunctionData, encodeFunctionResult, toHex, zeroAddress, zeroHash } from 'viem';
import type { FinalityAssessment } from '@gatopago/shared/v3/finality';
import { accountSecurityInspectionAbi } from '@gatopago/shared/v3/security-inspection';
import { signerId, type SecurityPolicy } from '@gatopago/shared/v3/security-policy';
import { fixtureAddress, fixtureHash, inspectionScenario } from './v3Inspection';
import { finalityPin, finalityPolicyFixture } from './v3Finality';

/** Synthetic current revision, no provider, deployment or network admission. */
export function securityInspectionScenario() {
	const base = inspectionScenario();
	const policy: SecurityPolicy = { mode: 'active', spendThreshold: 1, adminThreshold: 2,
		upgradeDelaySeconds: 259200, signers: ['a', 'b'].map((digit) => ({
			kind: 0 as const, key: fixtureAddress(digit), verifier: zeroAddress, verifierCodeHash: zeroHash, roles: 3,
		})).sort((a, b) => signerId(a).localeCompare(signerId(b))) };
	const wirePolicy = { ...policy, mode: 1, signers: [...policy.signers] };
	const security = { flags: 1n,
		securityVersion: 2n, manifestHash: fixtureHash('e'), chainScopeHash: fixtureHash('d'),
		creationValidAfter: 0n, creationValidUntil: 0n, spendNonce: 5n, adminNonce: 2n, wireRevision: 1n,
		pendingKind: 0n, pendingHash: zeroHash, pendingVersion: 0n, pendingPreviousManifestHash: zeroHash,
		pendingChainScopeHash: zeroHash, pendingReadyAt: 0n, pendingValidUntil: 0n };
	const words = () => [security.flags, security.securityVersion, BigInt(security.manifestHash), BigInt(security.chainScopeHash),
		security.creationValidAfter, security.creationValidUntil, security.spendNonce, security.adminNonce, security.wireRevision,
		security.pendingKind, BigInt(security.pendingHash), security.pendingVersion, BigInt(security.pendingPreviousManifestHash),
		BigInt(security.pendingChainScopeHash), security.pendingReadyAt, security.pendingValidUntil] as const;
	const original = base.request.getMockImplementation()!;
	base.request.mockImplementation(async (request) => {
		if (request.method === 'eth_call') {
			const call = request.params?.[0] as { data: `0x${string}` };
			let method;
			try { method = decodeFunctionData({ abi: accountSecurityInspectionAbi, data: call.data }).functionName; }
			catch { /* An original deployment inspection call. */ }
			if (method === 'securitySnapshot') return encodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: method, result: words() });
			if (method === 'securityPolicy') return encodeFunctionResult({ abi: accountSecurityInspectionAbi, functionName: method, result: wirePolicy });
		}
		return original(request);
	});
	return { ...base, security, wirePolicy, policy, words };
}

/** Recent finalized checkpoint deliberately differs from the older receipt target. */
export function finalizedSecurityScenario(now = Math.floor(Date.now() / 1000)) {
	const base = securityInspectionScenario(), pin = finalityPin(finalityPolicyFixture(base.manifest, now));
	const source: FinalityAssessment = { schema_version: 1, status: 'finalized', policy_sha256: pin.digest,
		mechanism: 'op_stack_l1_data_finalized', network_id: base.manifest.network_id, genesis_hash: base.manifest.genesis_hash,
		target: { block_number: '99', block_hash: fixtureHash('a'), block_timestamp: String(now - 10) },
		checkpoint: { ...base.input.checkpoint, block_timestamp: String(now - 2) }, assessed_at: now, expires_at: now + 30 };
	const chain = { finalizedHash: base.input.checkpoint.block_hash, finalizedTime: now - 2, latestTime: now };
	const original = base.request.getMockImplementation()!;
	base.request.mockImplementation(async (request) => {
		if (request.method !== 'eth_getBlockByNumber') return original(request);
		if (request.params?.[0] === '0x0') return { number: '0x0', hash: base.manifest.genesis_hash, timestamp: '0x0' };
		if (request.params?.[0] === 'latest') return { number: '0x65', hash: fixtureHash('c'), timestamp: toHex(chain.latestTime) };
		if (request.params?.[0] === 'finalized' || request.params?.[0] === '0x64') {
			return { number: '0x64', hash: chain.finalizedHash, timestamp: toHex(chain.finalizedTime) };
		}
		throw new Error('Unexpected security/finality height');
	});
	return { ...base, now, source, pin, chain, input: { ...base.input, finalityPolicy: pin, finalityEvidence: source,
		rpcUrls: ['https://first.example.test', 'https://second.example.test'] as const } };
}
