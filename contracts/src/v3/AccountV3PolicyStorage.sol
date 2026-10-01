// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";

/// @notice Lossless storage of the canonical V3 policy; never a source of new authority.
/// @dev Solidity packs typed fields. OZ StorageSlot/Packing operate on primitives, not
/// this policy schema; no custom assembly, signature encoding or cryptography is needed.
/// Authorization/enrollment remains the caller's responsibility before store(). No external
/// calls occur here. Public wire types, signer IDs, policy hashes and quorums stay unchanged.
library AccountV3PolicyStorage {
    error AccountV3PolicyStorage__InvalidStoredSigner();

    function store(D.StoredPolicy storage target, T.SecurityPolicy memory source) internal {
        // Validate before any write: an ambiguous descriptor must never be normalized into
        // a different valid identity by discarding a verifier, key suffix or code hash.
        P.validate(source);
        storeValidated(target, source);
    }

    /// @dev Internal fast path for initialization AFTER validateIdentity has validated this exact
    /// memory policy, and all possession verifications have been STATICCALLs. Never use for
    /// untrusted input or pending-state installation. This is storage, not an authorization API.
    function storeValidated(D.StoredPolicy storage target, T.SecurityPolicy memory source) internal {
        delete target.signers;
        target.mode = source.mode;
        target.spendThreshold = source.spendThreshold;
        target.adminThreshold = source.adminThreshold;
        target.upgradeDelaySeconds = source.upgradeDelaySeconds;
        for (uint256 i; i < source.signers.length; ++i) {
            T.SignerDescriptor memory signer = source.signers[i];
            D.StoredSigner storage stored = target.signers.push();
            stored.kind = signer.kind;
            stored.roles = signer.roles;
            stored.identity = signer.kind == P.ECDSA ? address(bytes20(signer.key)) : signer.verifier;
            if (signer.kind != P.ECDSA) stored.verifierCodeHash = signer.verifierCodeHash;
            if (signer.kind == P.WEBAUTHN) stored.key = signer.key;
        }
    }

    function load(D.StoredPolicy storage source) internal view returns (T.SecurityPolicy memory policy) {
        policy.mode = source.mode;
        policy.spendThreshold = source.spendThreshold;
        policy.adminThreshold = source.adminThreshold;
        policy.upgradeDelaySeconds = source.upgradeDelaySeconds;
        policy.signers = new T.SignerDescriptor[](source.signers.length);
        for (uint256 i; i < policy.signers.length; ++i) {
            policy.signers[i] = loadSigner(source.signers[i]);
        }
    }

    function loadSigner(D.StoredSigner storage source) internal view returns (T.SignerDescriptor memory signer) {
        signer.kind = source.kind;
        signer.roles = source.roles;
        if (signer.kind == P.WEBAUTHN) {
            signer.verifier = source.identity;
            signer.verifierCodeHash = source.verifierCodeHash;
            signer.key = source.key;
        } else {
            if (signer.kind > P.ERC1271) {
                revert AccountV3PolicyStorage__InvalidStoredSigner();
            }
            if (signer.kind == P.ERC1271) {
                signer.verifier = source.identity;
                signer.verifierCodeHash = source.verifierCodeHash;
            }
            signer.key = abi.encodePacked(source.identity);
        }
        // Validate active variant fields; unused words must not change signer identity
        // or force cold reads during creation. store() rejects ambiguous input before encoding.
        P.validateSigner(signer);
    }
}
