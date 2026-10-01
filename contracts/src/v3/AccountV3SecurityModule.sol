// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";

/// @notice Fixed security composition for Account V3, not an installable module system.
/// @dev Solidity links the library address into the implementation bytecode. Only the five typed
/// transitions, the canonical policy reader, the execution/ERC-1271 predicates and the one-time
/// initializer may delegate to it. The signature predicate is read-only and cannot execute calls.
/// No storage slot, caller input, registry or admin can change
/// that target. Namespace, caller and EIP-712 account domain stay in the proxy's context.
/// The captured codehash detects runtime drift, NOT trusted provenance: deployment admission must
/// verify the linked artifact/address/codehash on every enabled chain, including portable exit tools.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
abstract contract AccountV3SecurityModule {
    bytes32 public immutable securityModuleCodeHash;

    error AccountV3SecurityModule__MissingCode();
    error AccountV3SecurityModule__CodeChanged();

    constructor() {
        if (address(Security).code.length == 0) revert AccountV3SecurityModule__MissingCode();
        securityModuleCodeHash = address(Security).codehash;
    }

    modifier securityModuleIntact() {
        _checkSecurityModule();
        _;
    }

    function prepare(
        E.ChangeKind kind,
        T.SecurityChange memory message,
        T.SecurityPolicy memory next,
        uint256[] calldata chains,
        S.Signature[] memory auth,
        S.Signature[] memory proofs
    ) external securityModuleIntact returns (bytes32) {
        return Security.prepare(kind, message, next, chains, auth, proofs);
    }

    function commit(T.CommitProposal memory message, S.Signature[] memory auth) external securityModuleIntact {
        Security.commitPolicy(message, auth);
    }

    function cancel(T.CancelProposal memory message, S.Signature[] memory signatures) external securityModuleIntact {
        Security.cancel(message, signatures);
    }

    function freeze(T.FreezeUpgrades memory message, uint256[] calldata chains, S.Signature[] memory auth)
        external
        securityModuleIntact
    {
        Security.freezeUpgrades(message, chains, auth);
    }

    function expire(bytes32 proposal) external securityModuleIntact {
        Security.expire(proposal);
    }

    function securityModule() public pure returns (address) {
        return address(Security);
    }

    function securityPolicy() public view securityModuleIntact returns (T.SecurityPolicy memory) {
        return Security.readPolicy();
    }

    /// @notice Observe account-local security without relying on GatoPago or packed storage offsets.
    /// @dev Available while creation is pending. Does not expire, activate, emit, or sign.
    /// Read this and securityPolicy at the SAME canonical block, after verifying proxy/composition.
    /// An active policy is not evidence that the caller possesses usable signing factors.
    /// Fixed read-only wire schema (NOT storage offsets):
    /// [0] flags: initialized=1, upgradesFrozen=2, executing=4; other bits reserved;
    /// [1] securityVersion, [2] manifestHash, [3] chainScopeHash,
    /// [4..5] creation validAfter/validUntil, [6..7] spend/admin nonces, [8] wire revision (1),
    /// [9] pending kind, [10] pending hash, [11] pending version,
    /// [12] pending previous manifest, [13] pending chain scope, [14..15] readyAt/validUntil.
    /// Identity/generation remain in creationIdentity(). Hashes are unchanged 256-bit words.
    /// A fixed array uses a bounded ABI copy loop, retaining the account/library code budgets.
    function securitySnapshot() external view securityModuleIntact returns (uint256[16] memory result) {
        D.Layout storage state = D.layout();
        D.PendingProposal storage pending = state.pending;
        result[0] = (state.initialized ? 1 : 0) | (state.upgradesFrozen ? 2 : 0) | (state.executing ? 4 : 0);
        result[1] = state.securityVersion;
        result[2] = uint256(state.manifestHash);
        result[3] = uint256(state.chainScopeHash);
        result[4] = state.creationValidAfter;
        result[5] = state.creationValidUntil;
        result[6] = state.spendNonce;
        result[7] = state.adminNonce;
        // Wire revision marker: old snapshots must not be interpreted as consumer snapshots.
        result[8] = 1;
        result[9] = uint8(pending.kind);
        result[10] = uint256(pending.proposalHash);
        result[11] = pending.securityVersion;
        result[12] = uint256(pending.previousManifestHash);
        result[13] = uint256(pending.chainScopeHash);
        result[14] = pending.readyAt;
        result[15] = pending.validUntil;
    }

    function _checkSecurityModule() internal view {
        if (address(Security).codehash != securityModuleCodeHash) revert AccountV3SecurityModule__CodeChanged();
    }
}
