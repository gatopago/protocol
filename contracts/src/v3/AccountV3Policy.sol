// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";

/// @notice Bounded structural policy validation, not enrollment or permission to execute.
/// @dev Mirrors shared/v3/securityPolicy.ts. Distinct keys do not prove independent devices/owners.
library AccountV3Policy {
    uint8 internal constant ECDSA = 0;
    uint8 internal constant WEBAUTHN = 1;
    uint8 internal constant ERC1271 = 2;
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant SPEND = 1;
    uint8 internal constant ADMIN = 2;
    uint256 internal constant MAX_SIGNERS = 16;

    error AccountV3Policy__InvalidPolicy();
    error AccountV3Policy__InvalidSigner();
    error AccountV3Policy__UnsortedSigners();
    error AccountV3Policy__DuplicateKey();
    error AccountV3Policy__InvalidThreshold();
    error AccountV3Policy__InvalidDelay();

    function validate(T.SecurityPolicy memory policy) internal pure {
        if (policy.mode != ACTIVE || policy.signers.length == 0 || policy.signers.length > MAX_SIGNERS) {
            revert AccountV3Policy__InvalidPolicy();
        }
        if (policy.upgradeDelaySeconds < T.MIN_UPGRADE_DELAY || policy.upgradeDelaySeconds > 30 days) {
            revert AccountV3Policy__InvalidDelay();
        }
        if (policy.spendThreshold > MAX_SIGNERS || policy.adminThreshold > MAX_SIGNERS) {
            revert AccountV3Policy__InvalidThreshold();
        }

        bytes32[] memory fingerprints = new bytes32[](policy.signers.length);
        bytes32 previousId;
        uint256 spend;
        uint256 admin;
        for (uint256 i; i < policy.signers.length; ++i) {
            T.SignerDescriptor memory signer = policy.signers[i];
            validateSigner(signer);
            bytes32 id = T.signerId(signer);
            if (i != 0 && id <= previousId) revert AccountV3Policy__UnsortedSigners();
            previousId = id;
            fingerprints[i] = keyFingerprint(signer);
            for (uint256 j; j < i; ++j) {
                if (fingerprints[j] == fingerprints[i]) revert AccountV3Policy__DuplicateKey();
            }
            if ((signer.roles & SPEND) != 0) ++spend;
            if ((signer.roles & ADMIN) != 0) ++admin;
        }
        if (
            policy.spendThreshold == 0 || policy.spendThreshold > spend || policy.adminThreshold == 0
                || policy.adminThreshold > admin
        ) {
            revert AccountV3Policy__InvalidThreshold();
        }
    }

    function validateSigner(T.SignerDescriptor memory signer) internal pure {
        if (signer.kind > ERC1271 || signer.roles == 0 || signer.roles > (SPEND | ADMIN)) {
            revert AccountV3Policy__InvalidSigner();
        }
        if (signer.kind == WEBAUTHN) {
            // Structure only; curve point, RP/origin, UV and possession are verified by the pinned verifier.
            if (signer.key.length != 128 || keccak256(signer.key) == keccak256(new bytes(128))) {
                revert AccountV3Policy__InvalidSigner();
            }
        } else if (signer.key.length != 20 || address(bytes20(signer.key)) == address(0)) {
            revert AccountV3Policy__InvalidSigner();
        }
        if (signer.kind == ECDSA) {
            if (signer.verifier != address(0) || signer.verifierCodeHash != bytes32(0)) {
                revert AccountV3Policy__InvalidSigner();
            }
        } else {
            if (signer.verifier == address(0) || signer.verifierCodeHash == bytes32(0)) {
                revert AccountV3Policy__InvalidSigner();
            }
            // ERC-1271 is the wallet itself, NOT an arbitrary ERC-7913 adapter with a different key.
            if (signer.kind == ERC1271 && signer.verifier != address(bytes20(signer.key))) {
                revert AccountV3Policy__InvalidSigner();
            }
        }
    }

    /// @dev Call only after validateSigner; RP/origin/verifier aliases never create extra votes.
    function keyFingerprint(T.SignerDescriptor memory signer) internal pure returns (bytes32) {
        return keccak256(signer.kind == WEBAUTHN ? Bytes.slice(signer.key, 64) : signer.key);
    }
}
