import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { concatHex, encodeAbiParameters, hexToBytes, keccak256, type Hex } from 'viem';
import { deploymentDocumentDigest } from '@gatopago/shared/v3/deployment';
import { prepareInitialization, type AccountCreationProfile, type InitializationInput } from '@gatopago/shared/v3/initialization';
import { webAuthnKeyFromSpki } from '@gatopago/shared/v3/webauthn';
import { fixtureAddress, fixtureHash, fixtureManifest } from './v3DeploymentFixture';

/** Synthetic profiles and ephemeral keys ONLY. No actual release, manifest admission,
 * user credential, chain observation, audit or original artifact provenance. */
export function initializationFixture() {
	const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const scope = { rpId: 'gatopago.com', origin: 'https://gatopago.com' };
	const publicKey = webAuthnKeyFromSpki(scope, key.publicKey.export({ format: 'der', type: 'spki' }));
	const profile: AccountCreationProfile = { schema_version: 1, purpose: 'account_creation', deployment: fixtureManifest(),
		proxy_creation_code: '0x6001600055', webauthn_verifier: { ...fixtureManifest().components.implementation, address: fixtureAddress('a') },
		entry_point_code_hash: fixtureHash('c'), sender_creator: { address: fixtureAddress('b'), runtime_code_hash: fixtureHash('d') } };
	const document = JSON.stringify({ ...profile, deployment: { ...profile.deployment, proxy: { ...profile.deployment.proxy,
		init_code_hash: keccak256(concatHex([profile.proxy_creation_code,
			encodeAbiParameters([{ type: 'address' }], [profile.deployment.components.implementation.address])])) } } });
	const parsed: AccountCreationProfile = JSON.parse(document);
	const now = Math.floor(Date.now() / 1000);
	const input: InitializationInput = { document, expectedDigest: deploymentDocumentDigest(document), scope, publicKey,
		userSaltCommitment: fixtureHash('f'), validAfter: now, validUntil: now + 300 };
	const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
	function assertion(challenge: Hex = prepareInitialization(input).digest, options: { origin?: string; flags?: number; count?: number } = {}) {
		const authenticatorData = new Uint8Array(37); authenticatorData.set(hash(scope.rpId)); authenticatorData[32] = options.flags ?? 5;
		new DataView(authenticatorData.buffer).setUint32(33, options.count ?? 2, false);
		const json = JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(hexToBytes(challenge)).toString('base64url'),
			origin: options.origin ?? scope.origin, crossOrigin: false });
		return { authenticatorData, clientDataJSON: new TextEncoder().encode(json),
			signatureDER: new Uint8Array(sign('sha256', Buffer.concat([authenticatorData, hash(json)]), key.privateKey)) };
	}
	return { input, profile: parsed, pin: { document, digest: input.expectedDigest }, assertion };
}
