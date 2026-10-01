// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";

/// @notice E0 storage specification. No external methods, authority or account implementation.
/// @dev This is a new namespace, NOT a V1/V2 storage migration. Gate A is still required.
library AccountV3Storage {
    // keccak256(abi.encode(uint256(keccak256("gatopago.account.v3")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_LOCATION = 0xf7d3d237b2c0508303945fc9697caadd1c97ac71f8ac5d69804370418184b000;
    // Compiler-derived SHA-256 commitment; scripts/v3-storage-layout.mjs verifies it.
    bytes32 internal constant LAYOUT_HASH = 0xdcd24b64ea3d183f0c8ec0cf5f2f5a3ed15545805791416ab100c3a0ca160f49;

    enum ProposalKind {
        None,
        Security,
        Upgrade
    }

    /// @dev Storage representation only; T.SignerDescriptor remains the signed/public format.
    /// identity is the ECDSA key, ERC-1271 wallet, or WebAuthn verifier. Only WebAuthn
    /// needs key bytes: address-based keys are reconstructed without storing them twice.
    /// Tagged union: ECDSA uses only the packed header; ERC-1271 also uses codeHash;
    /// WebAuthn uses all fields. Inactive variant fields are never authoritative.
    struct StoredSigner {
        uint8 kind;
        uint8 roles;
        address identity;
        bytes32 verifierCodeHash;
        bytes key;
    }

    struct StoredPolicy {
        uint8 mode;
        uint16 spendThreshold;
        uint16 adminThreshold;
        uint48 upgradeDelaySeconds;
        StoredSigner[] signers;
    }

    struct PendingProposal {
        ProposalKind kind;
        uint64 securityVersion;
        uint48 readyAt;
        uint48 validUntil;
        bytes32 proposalHash;
        bytes32 previousManifestHash;
        bytes32 chainScopeHash;
        T.SecurityPolicy nextPolicy;
        T.UpgradeManifest upgrade;
    }

    /// @custom:storage-location erc7201:gatopago.account.v3
    struct Layout {
        uint32 generation;
        bool initialized;
        bool upgradesFrozen;
        uint64 securityVersion;
        bool executing;
        // Signed V3 timestamps, packed in the existing header. until != 0 means pending.
        // Persistent: a transaction boundary must not waive initialization expiry.
        uint48 creationValidAfter;
        uint48 creationValidUntil;
        bytes32 initialSecurityCommitment;
        bytes32 userSaltCommitment;
        bytes32 manifestHash;
        bytes32 chainScopeHash;
        uint256 spendNonce;
        uint256 adminNonce;
        StoredPolicy policy;
        PendingProposal pending;
    }

    function layout() internal pure returns (Layout storage state) {
        assembly ("memory-safe") {
            state.slot := STORAGE_LOCATION
        }
    }

    /// @dev The immutable identity is derived from its stored preimage, not stored a second time.
    /// Consumers must check initialization before treating this value as an account identity.
    function accountId(Layout storage state) internal view returns (bytes32) {
        return T.accountId(state.initialSecurityCommitment, state.userSaltCommitment);
    }
}
