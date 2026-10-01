// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AccountV3Interop} from "src/v3/AccountV3Interop.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Upgrade as Upgrade, IAccountV3UpgradeTarget} from "src/v3/AccountV3Upgrade.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";

/// @notice Local Account V3 candidate: creation, security, execution, interop and user-approved UUPS.
/// @dev No deployment/mainnet approval. Both fixed library links are part of the signed/audited
/// implementation artifact. They are NOT installable modules or targets selected by a user call.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
contract AccountV3 is AccountV3Interop, UUPSUpgradeable, IAccountV3UpgradeTarget {
    using TransientSlot for *;

    bytes32 private constant UPGRADE_TARGET_SLOT = keccak256("gatopago.account.v3.upgrade.authorization");
    bytes32 private constant MIGRATION_HASH_SLOT = keccak256("gatopago.account.v3.upgrade.migration");
    bytes32 public immutable upgradeModuleCodeHash;

    error AccountV3__UpgradeModuleChanged();
    error AccountV3__TypedUpgradeRequired();

    constructor(address ep) AccountV3Interop(ep) {
        if (address(Upgrade).code.length == 0) revert AccountV3__UpgradeModuleChanged();
        upgradeModuleCodeHash = address(Upgrade).codehash;
    }

    /// @dev Revision-specific migration entrypoints MUST use this one-shot gate. A generic
    /// executing flag also covers spending and is not upgrade authority. Nested callbacks cannot
    /// consume this authorization again, even if they reproduce the exact calldata.
    modifier onlyUpgradeMigration() {
        bytes32 expected = MIGRATION_HASH_SLOT.asBytes32().tload();
        if (!D.layout().executing || expected == bytes32(0) || keccak256(msg.data) != expected) {
            revert AccountV3__TypedUpgradeRequired();
        }
        MIGRATION_HASH_SLOT.asBytes32().tstore(bytes32(0));
        _;
    }

    function proposeUpgrade(
        T.UpgradeManifest memory message,
        uint256[] calldata chains,
        S.Signature[] memory signatures
    ) external onlyProxy returns (bytes32) {
        _checkUpgradeModules();
        return Upgrade.propose(message, chains, signatures, address(entryPoint()), storageLayoutHash());
    }

    function commitUpgrade(T.CommitProposal memory message, bytes memory migration, S.Signature[] memory signatures)
        external
        nonReentrant
        onlyProxy
    {
        _checkUpgradeModules();
        (address target, bytes32 checkpoint) =
            Upgrade.consume(message, migration, signatures, address(entryPoint()), storageLayoutHash());
        UPGRADE_TARGET_SLOT.asAddress().tstore(target);
        if (migration.length != 0) MIGRATION_HASH_SLOT.asBytes32().tstore(keccak256(migration));
        super.upgradeToAndCall(target, migration);
        if (MIGRATION_HASH_SLOT.asBytes32().tload() != bytes32(0)) revert AccountV3__TypedUpgradeRequired();
        UPGRADE_TARGET_SLOT.asAddress().tstore(address(0));
        Upgrade.finish(target, checkpoint);
    }

    /// @dev Standard selector deliberately cannot bypass the typed prepare/commit protocol.
    function upgradeToAndCall(address, bytes memory) public payable override {
        revert AccountV3__TypedUpgradeRequired();
    }

    function upgradeModule() public pure returns (address) {
        return address(Upgrade);
    }

    function storageLayoutHash() public pure virtual returns (bytes32) {
        return D.LAYOUT_HASH;
    }

    /// @dev Next revisions may declare reviewed append-only/new-namespace compatibility. This
    /// declaration is NOT a compiler diff. Unknown predecessor layouts fail closed by default.
    function upgradeCompatibility(bytes32 previousLayout, address ep, uint32 generation)
        external
        view
        virtual
        notDelegated
        returns (bytes32)
    {
        _checkUpgradeModules();
        if (previousLayout != D.LAYOUT_HASH || ep != address(entryPoint()) || generation != T.GENERATION) {
            return bytes32(0);
        }
        return storageLayoutHash();
    }

    function _authorizeUpgrade(address target) internal view override {
        if (!D.layout().executing || target == address(0) || UPGRADE_TARGET_SLOT.asAddress().tload() != target) {
            revert AccountV3__TypedUpgradeRequired();
        }
    }

    function _checkUpgradeModules() internal view {
        _checkSecurityModule();
        if (address(Upgrade).codehash != upgradeModuleCodeHash) revert AccountV3__UpgradeModuleChanged();
    }
}
