// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";

/// @dev A target declaration, NOT a proof of safe bytecode or storage compatibility.
/// Admission still requires reproducible bytecode, compiler storage diff and independent review.
interface IAccountV3UpgradeTarget {
    function upgradeCompatibility(bytes32 previousLayout, address entryPoint, uint32 generation)
        external
        view
        returns (bytes32 nextLayout);
}

/// @notice Fixed linked upgrade protocol. No selector dispatch, arbitrary CALL or ERC-1967 write.
/// @dev Only AccountV3's typed entrypoints may delegate here; the link/codehash is pinned.
/// OZ UUPS performs the implementation change separately, inside the same atomic transaction.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
library AccountV3Upgrade {
    event UpgradeProposed(
        bytes32 indexed proposalHash, address indexed implementation, uint48 readyAt, uint48 validUntil
    );
    event UpgradeCommitted(
        bytes32 indexed proposalHash, bytes32 acknowledgementsHash, bytes32 manifestHash, uint64 securityVersion
    );

    error AccountV3Upgrade__Disabled();
    error AccountV3Upgrade__InvalidTarget();
    error AccountV3Upgrade__InvalidMigration();
    error AccountV3Upgrade__MigrationCorruptedCore();

    function propose(
        T.UpgradeManifest memory message,
        uint256[] calldata chains,
        S.Signature[] memory signatures,
        address entryPoint,
        bytes32 currentLayout
    ) public returns (bytes32 proposalHash) {
        D.Layout storage state = Security._state();
        Security._checkMessage(
            state,
            message.accountId,
            message.generation,
            message.securityVersion,
            message.validAfter,
            message.validUntil
        );
        Security._predecessor(state, message.previousManifestHash);
        Security._scope(message.chainScopeHash, chains);
        _enabled(state);
        if (state.pending.kind != D.ProposalKind.None) revert Security.AccountV3Security__PendingProposal();
        Security._nonce(message.nonce, state.adminNonce);
        _target(message, entryPoint, currentLayout);
        uint48 readyAt = SafeCast.toUint48(uint256(Security._now()) + state.policy.upgradeDelaySeconds);
        if (readyAt >= message.validUntil) revert Security.AccountV3Security__TimelockExceedsValidity();
        proposalHash = T.digest(block.chainid, address(this), T.hashUpgrade(message));
        _consent(state, proposalHash, signatures);
        ++state.adminNonce;
        D.PendingProposal storage pending = state.pending;
        pending.kind = D.ProposalKind.Upgrade;
        pending.securityVersion = state.securityVersion;
        pending.readyAt = readyAt;
        pending.validUntil = message.validUntil;
        pending.proposalHash = proposalHash;
        pending.previousManifestHash = state.manifestHash;
        pending.chainScopeHash = message.chainScopeHash;
        pending.upgrade = message;
        emit UpgradeProposed(proposalHash, message.implementation, readyAt, message.validUntil);
    }

    /// @dev Fresh CommitProposal quorum, not the original UpgradeManifest signatures. Consumed
    /// state and the migration lock roll back if UUPS, migration or postconditions fail.
    function consume(
        T.CommitProposal memory message,
        bytes memory migration,
        S.Signature[] memory signatures,
        address entryPoint,
        bytes32 currentLayout
    ) public returns (address implementation, bytes32 checkpoint) {
        D.Layout storage state = Security._state();
        Security._checkMessage(
            state,
            message.accountId,
            message.generation,
            message.securityVersion,
            message.validAfter,
            message.validUntil
        );
        Security._predecessor(state, message.previousManifestHash);
        _enabled(state);
        if (state.pending.kind != D.ProposalKind.Upgrade) revert Security.AccountV3Security__WrongProposal();
        Security._pending(state, message.proposalHash);
        Security._ready(state.pending);
        if (message.chainScopeHash != state.pending.chainScopeHash) revert Security.AccountV3Security__WrongScope();
        if (message.acknowledgementsHash == bytes32(0)) revert Security.AccountV3Security__MissingAcknowledgements();
        Security._nonce(message.nonce, state.adminNonce);
        T.UpgradeManifest memory upgrade = state.pending.upgrade;
        if (keccak256(migration) != upgrade.migrationCallHash) revert AccountV3Upgrade__InvalidMigration();
        _target(upgrade, entryPoint, currentLayout);
        _consent(state, T.digest(block.chainid, address(this), T.hashCommit(message)), signatures);
        implementation = upgrade.implementation;
        ++state.adminNonce;
        state.securityVersion = SafeCast.toUint64(uint256(state.securityVersion) + 1);
        state.manifestHash = T.hashManifest(
            T.SecurityManifest(
                D.accountId(state),
                state.generation,
                state.securityVersion,
                state.manifestHash,
                T.hashPolicy(PS.load(state.policy)),
                message.chainScopeHash
            )
        );
        state.chainScopeHash = message.chainScopeHash;
        delete state.pending;
        state.executing = true;
        checkpoint = _checkpoint(state);
        emit UpgradeCommitted(
            message.proposalHash, message.acknowledgementsHash, state.manifestHash, state.securityVersion
        );
    }

    /// @dev Checks the stable core, not arbitrary token balances/mapping entries/new namespaces.
    /// These postconditions do NOT make malicious user-approved bytecode safe.
    function finish(address implementation, bytes32 checkpoint) public {
        D.Layout storage state = D.layout();
        if (!state.executing || ERC1967Utils.getImplementation() != implementation || _checkpoint(state) != checkpoint)
        {
            revert AccountV3Upgrade__MigrationCorruptedCore();
        }
        state.executing = false;
    }

    function _enabled(D.Layout storage state) private view {
        if (state.policy.mode != P.ACTIVE || state.upgradesFrozen) revert AccountV3Upgrade__Disabled();
    }

    function _consent(D.Layout storage state, bytes32 digest, S.Signature[] memory signatures) private view {
        // The policy was validated before storage installation; no caller-provided policy here.
        if (!S.verifyValidatedQuorum(PS.load(state.policy), P.ADMIN, digest, signatures)) {
            revert Security.AccountV3Security__InvalidConsent();
        }
    }

    function _target(T.UpgradeManifest memory message, address entryPoint, bytes32 currentLayout) private view {
        address target = message.implementation;
        if (
            target.code.length == 0 || target == ERC1967Utils.getImplementation() || target == address(this)
                || target.codehash != message.runtimeCodeHash || message.storageLayoutHash == bytes32(0)
                || _word(target, abi.encodeCall(IERC1822Proxiable.proxiableUUID, ()))
                    != ERC1967Utils.IMPLEMENTATION_SLOT
                || _word(
                        target,
                        abi.encodeCall(
                            IAccountV3UpgradeTarget.upgradeCompatibility, (currentLayout, entryPoint, T.GENERATION)
                        )
                    ) != message.storageLayoutHash
        ) {
            revert AccountV3Upgrade__InvalidTarget();
        }
    }

    /// @dev OZ LowLevelCall has no per-call gas cap. Bound both gas and returndata here;
    /// OZ still owns UUPS checking and the actual implementation write. Exact single-word ABI.
    function _word(address target, bytes memory input) private view returns (bytes32 result) {
        bool valid;
        assembly ("memory-safe") {
            mstore(0x00, 0)
            let success := staticcall(60000, target, add(input, 0x20), mload(input), 0x00, 0x20)
            valid := and(success, eq(returndatasize(), 0x20))
            result := mload(0x00)
        }
        if (!valid) revert AccountV3Upgrade__InvalidTarget();
    }

    function _checkpoint(D.Layout storage state) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                state.generation,
                state.initialized,
                state.upgradesFrozen,
                state.securityVersion,
                state.executing,
                state.creationValidAfter,
                state.creationValidUntil,
                state.initialSecurityCommitment,
                state.userSaltCommitment,
                state.manifestHash,
                state.chainScopeHash,
                state.spendNonce,
                state.adminNonce,
                T.hashPolicy(PS.load(state.policy)),
                state.pending,
                address(this).balance
            )
        );
    }
}
