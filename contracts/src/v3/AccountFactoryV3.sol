// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AccountV3Proxy} from "src/v3/AccountV3Proxy.sol";
import {AccountV3Initializable} from "src/v3/AccountV3Initializable.sol";
import {AccountV3Initialization as I} from "src/v3/AccountV3Initialization.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3SecurityModule} from "src/v3/AccountV3SecurityModule.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Upgrade as Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @dev Getter required by the supported ERC-4337 deployment path; absent from the installed OZ interface.
interface IAccountV3SenderCreatorSource {
    function senderCreator() external view returns (address);
}

/// @notice Immutable candidate factory. Network manifests still need to admit these exact artifacts.
/// @dev No owner, deployment registry, relayer authority or fallback to V1/V2.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
contract AccountFactoryV3 {
    /// @dev Expected CURRENT artifact, supplied by the caller's independently admitted manifest.
    /// Matching this tuple proves consistency, NOT that an arbitrary caller-selected artifact is safe.
    struct ImplementationExpectation {
        address implementation;
        bytes32 runtimeCodeHash;
        bytes32 storageLayoutHash;
        address securityModule;
        bytes32 securityModuleCodeHash;
        address upgradeModule;
        bytes32 upgradeModuleCodeHash;
    }

    struct AccountInspection {
        address account;
        bytes32 accountId;
        address implementation;
        uint64 securityVersion;
        bytes32 storageLayoutHash;
    }

    address public immutable implementation;
    address public immutable entryPoint;
    address public immutable senderCreator;
    bytes32 public immutable implementationCodeHash;
    bytes32 public immutable entryPointCodeHash;
    bytes32 public immutable senderCreatorCodeHash;
    bytes32 public immutable securityModuleCodeHash;
    bytes32 public immutable upgradeModuleCodeHash;
    bytes32 public immutable proxyInitCodeHash;

    event AccountCreated(bytes32 indexed accountId, address indexed account, bytes32 initialSecurityCommitment);

    error AccountFactoryV3__InvalidDeployment();
    error AccountFactoryV3__WrongCaller();
    error AccountFactoryV3__DeploymentChanged();
    error AccountFactoryV3__ExistingAccountMismatch();
    error AccountFactoryV3__AccountNotDeployed();
    error AccountFactoryV3__UnexpectedCurrentImplementation();

    constructor(address implementation_, address entryPoint_) {
        if (implementation_.code.length == 0 || entryPoint_.code.length == 0) {
            revert AccountFactoryV3__InvalidDeployment();
        }
        if (AccountV3Initializable(implementation_).initializationEntryPoint() != entryPoint_) {
            revert AccountFactoryV3__InvalidDeployment();
        }
        // Compiler-linked target must match the implementation's fixed composition. Capturing an
        // already-substituted runtime is not provenance: manifests must still attest the artifact.
        if (
            address(Security).code.length == 0
                || AccountV3SecurityModule(implementation_).securityModule() != address(Security)
                || AccountV3SecurityModule(implementation_).securityModuleCodeHash() != address(Security).codehash
        ) revert AccountFactoryV3__InvalidDeployment();
        AccountV3 candidate = AccountV3(payable(implementation_));
        if (
            address(Upgrade).code.length == 0 || candidate.upgradeModule() != address(Upgrade)
                || candidate.upgradeModuleCodeHash() != address(Upgrade).codehash
                || address(candidate.entryPoint()) != entryPoint_ || candidate.storageLayoutHash() != D.LAYOUT_HASH
                || candidate.proxiableUUID() != ERC1967Utils.IMPLEMENTATION_SLOT
        ) revert AccountFactoryV3__InvalidDeployment();
        address creator = IAccountV3SenderCreatorSource(entryPoint_).senderCreator();
        if (creator.code.length == 0 || creator == entryPoint_) revert AccountFactoryV3__InvalidDeployment();
        implementation = implementation_;
        entryPoint = entryPoint_;
        senderCreator = creator;
        implementationCodeHash = implementation_.codehash;
        entryPointCodeHash = entryPoint_.codehash;
        senderCreatorCodeHash = creator.codehash;
        securityModuleCodeHash = address(Security).codehash;
        upgradeModuleCodeHash = address(Upgrade).codehash;
        proxyInitCodeHash = keccak256(_proxyCode(implementation_));
    }

    function createAccount(
        T.InitializationApproval calldata message,
        T.SecurityPolicy calldata policy,
        uint256[] calldata chains,
        S.Signature[] calldata proofs
    ) external returns (address account) {
        if (msg.sender != senderCreator) revert AccountFactoryV3__WrongCaller();
        if (
            implementation.codehash != implementationCodeHash || senderCreator.codehash != senderCreatorCodeHash
                || address(Security).codehash != securityModuleCodeHash
                || address(Upgrade).codehash != upgradeModuleCodeHash
        ) revert AccountFactoryV3__DeploymentChanged();
        bytes32 id = T.accountId(message.initialSecurityCommitment, message.userSaltCommitment);
        account = Create2.computeAddress(id, proxyInitCodeHash, address(this));
        if (account.code.length != 0) {
            // No writes or new authority. Expired initial proofs do not resurrect an old policy.
            I.validateIdentity(message, policy, address(this), entryPoint);
            _checkExisting(account, message);
            return account;
        }
        // Native CREATE2 avoids OZ Create2.deploy's SELFBALANCE check in the validation frame.
        // OZ still supplies address derivation and the ERC-1967 proxy implementation.
        // The authenticated initializer validates identity, policy and every possession proof.
        // Repeating that full policy scan here costs gas without adding authority. Any failure
        // rolls CREATE2 back atomically; the salt is derived, never trusted from the message.
        address deployed = address(new AccountV3Proxy{salt: id}(implementation));
        if (deployed != account) revert AccountFactoryV3__InvalidDeployment();
        AccountV3Initializable(account).initialize(message, policy, chains, proofs);
        _checkExisting(account, message);
        emit AccountCreated(message.accountId, account, message.initialSecurityCommitment);
    }

    function getAddress(bytes32 initialSecurityCommitment, bytes32 userSaltCommitment) public view returns (address) {
        return Create2.computeAddress(
            T.accountId(initialSecurityCommitment, userSaltCommitment), proxyInitCodeHash, address(this)
        );
    }

    /// @notice Read a deployed account, including a user-approved upgrade, without reinitializing it.
    /// @dev Outside ERC-4337 validation: no clock or I/O from this helper enters createAccount.
    /// A new implementation need not reuse this factory's original library addresses or layout.
    /// This is NOT a GatoPago upgrade allowlist; no registry, signature authority or state is added.
    /// Callers must authenticate this factory's own artifact and the expectation independently.
    function inspectAccount(
        bytes32 initialSecurityCommitment,
        bytes32 userSaltCommitment,
        ImplementationExpectation calldata expected
    ) external view returns (AccountInspection memory observation) {
        address account = getAddress(initialSecurityCommitment, userSaltCommitment);
        if (account.code.length == 0) revert AccountFactoryV3__AccountNotDeployed();
        if (account.codehash != keccak256(type(AccountV3Proxy).runtimeCode)) {
            revert AccountFactoryV3__ExistingAccountMismatch();
        }
        // This getter belongs to the pinned proxy runtime, NOT to the possibly unknown target.
        address target = AccountV3Proxy(payable(account)).proxyImplementation();
        if (
            target != expected.implementation || target.code.length == 0 || expected.runtimeCodeHash == bytes32(0)
                || target.codehash != expected.runtimeCodeHash || expected.storageLayoutHash == bytes32(0)
                || expected.securityModule.code.length == 0 || expected.upgradeModule.code.length == 0
                || expected.securityModule.codehash != expected.securityModuleCodeHash
                || expected.upgradeModule.codehash != expected.upgradeModuleCodeHash
        ) revert AccountFactoryV3__UnexpectedCurrentImplementation();
        // Only after code matching may any delegated implementation getter be trusted.
        AccountV3 current = AccountV3(payable(target));
        if (
            current.initializationEntryPoint() != entryPoint || address(current.entryPoint()) != entryPoint
                || current.storageLayoutHash() != expected.storageLayoutHash
                || current.proxiableUUID() != ERC1967Utils.IMPLEMENTATION_SLOT
                || current.securityModule() != expected.securityModule
                || current.securityModuleCodeHash() != expected.securityModuleCodeHash
                || current.upgradeModule() != expected.upgradeModule
                || current.upgradeModuleCodeHash() != expected.upgradeModuleCodeHash
        ) revert AccountFactoryV3__UnexpectedCurrentImplementation();
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) =
            AccountV3Initializable(account).creationIdentity();
        if (
            generation != T.GENERATION || id != T.accountId(initialSecurityCommitment, userSaltCommitment)
                || commitment != initialSecurityCommitment || salt != userSaltCommitment
        ) revert AccountFactoryV3__ExistingAccountMismatch();
        observation = AccountInspection(
            account, id, target, AccountV3(payable(account)).securityVersion(), expected.storageLayoutHash
        );
        // Identity inspection never asserts spend-readiness, completed creation, fresh RPC evidence,
        // matching cross-chain state or safe financial execution. Those require separate checks.
    }

    function _checkExisting(address account, T.InitializationApproval calldata message) private view {
        if (account.codehash != keccak256(type(AccountV3Proxy).runtimeCode)) {
            revert AccountFactoryV3__ExistingAccountMismatch();
        }
        // Creation-only profile: after a legitimate upgrade, use getAddress, NOT this initializer path.
        if (AccountV3Proxy(payable(account)).proxyImplementation() != implementation) {
            revert AccountFactoryV3__ExistingAccountMismatch();
        }
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) =
            AccountV3Initializable(account).creationIdentity();
        if (
            generation != T.GENERATION || id != message.accountId || commitment != message.initialSecurityCommitment
                || salt != message.userSaltCommitment
        ) revert AccountFactoryV3__ExistingAccountMismatch();
    }

    function _proxyCode(address implementation_) private pure returns (bytes memory) {
        return abi.encodePacked(type(AccountV3Proxy).creationCode, abi.encode(implementation_));
    }
}
