// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {AccountV3Proxy} from "src/v3/AccountV3Proxy.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3SecurityModule} from "src/v3/AccountV3SecurityModule.sol";

/// @notice Authenticated creation base, NOT a complete Account/4337 executor or UUPS implementation.
/// @dev Self/address commitments avoid a circular immutable factory/implementation deployment dependency.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
abstract contract AccountV3Initializable is Initializable, AccountV3SecurityModule {
    address private immutable _initializationEntryPoint;
    address private immutable _initializationImplementation;

    event AccountInitialized(bytes32 indexed accountId, bytes32 manifestHash, bytes32 approvalDigest);

    error AccountV3Initializable__InvalidEntryPoint();
    error AccountV3Initializable__WrongProxyContext();

    constructor(address entryPoint_) {
        if (entryPoint_.code.length == 0) revert AccountV3Initializable__InvalidEntryPoint();
        _initializationEntryPoint = entryPoint_;
        _initializationImplementation = address(this);
        _disableInitializers();
    }

    function initialize(
        T.InitializationApproval calldata message,
        T.SecurityPolicy memory policy,
        uint256[] calldata chains,
        S.Signature[] calldata proofs
    ) external initializer securityModuleIntact {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(AccountV3Proxy).creationCode, abi.encode(_initializationImplementation))
        );
        if (
            address(this) == _initializationImplementation
                || ERC1967Utils.getImplementation() != _initializationImplementation
                || address(this).codehash != keccak256(type(AccountV3Proxy).runtimeCode)
                || Create2.computeAddress(
                        T.accountId(message.initialSecurityCommitment, message.userSaltCommitment),
                        initCodeHash,
                        msg.sender
                    ) != address(this)
        ) {
            revert AccountV3Initializable__WrongProxyContext();
        }
        // The fixed library checks the exact identity/policy before any possession proof or write.
        // Keep that implementation single-copy; proxy context remains enforced here.
        Security.installInitialPolicy(message, policy, chains, proofs, _initializationEntryPoint);
        emit AccountInitialized(
            message.accountId,
            D.layout().manifestHash,
            T.digest(block.chainid, address(this), T.hashInitialization(message))
        );
    }

    function initializationEntryPoint() public view returns (address) {
        return _initializationEntryPoint;
    }

    /// @dev Immutable deployment identity, not the mutable current policy. Never grants spending authority.
    function creationIdentity()
        external
        view
        returns (uint32 generation, bytes32 accountId, bytes32 initialCommitment, bytes32 saltCommitment)
    {
        D.Layout storage state = D.layout();
        return (
            state.generation,
            state.initialized ? D.accountId(state) : bytes32(0),
            state.initialSecurityCommitment,
            state.userSaltCommitment
        );
    }
}
