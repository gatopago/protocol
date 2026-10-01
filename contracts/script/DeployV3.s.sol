// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {AccountV3Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";
import {DeploymentRoles} from "script/DeploymentRoles.sol";

/// @notice Same construction path used by the release script and local tests.
/// @dev Library addresses are compiler links, never user-supplied delegatecall targets.
library V3Deployment {
    bytes32 internal constant SALT = keccak256("gatopago.account.v3.0-consumer.solc-0.8.34");

    struct Stack {
        AccountV3 implementation;
        AccountFactoryV3 factory;
        AccountV3WebAuthnVerifier verifier;
    }

    event Component(bytes32 indexed name, address indexed deployed, bytes32 runtimeCodeHash, bytes32 initCodeHash);
    event InitialIdentity(address indexed factory, address indexed initialImplementation, bytes32 proxyInitCodeHash);

    function deploy(address entryPoint) internal returns (Stack memory stack) {
        stack.verifier = new AccountV3WebAuthnVerifier{salt: SALT}();
        stack.implementation = new AccountV3{salt: SALT}(entryPoint);
        stack.factory = new AccountFactoryV3{salt: SALT}(address(stack.implementation), entryPoint);
        emit Component("security", address(AccountV3Security), address(AccountV3Security).codehash, bytes32(0));
        emit Component("upgrade", address(AccountV3Upgrade), address(AccountV3Upgrade).codehash, bytes32(0));
        emit Component(
            "verifier",
            address(stack.verifier),
            address(stack.verifier).codehash,
            keccak256(type(AccountV3WebAuthnVerifier).creationCode)
        );
        emit Component(
            "implementation",
            address(stack.implementation),
            address(stack.implementation).codehash,
            keccak256(abi.encodePacked(type(AccountV3).creationCode, abi.encode(entryPoint)))
        );
        emit Component(
            "factory",
            address(stack.factory),
            address(stack.factory).codehash,
            keccak256(
                abi.encodePacked(
                    type(AccountFactoryV3).creationCode, abi.encode(address(stack.implementation), entryPoint)
                )
            )
        );
        emit InitialIdentity(address(stack.factory), address(stack.implementation), stack.factory.proxyInitCodeHash());
    }
}

/// @notice Phase 1: deterministic fixed libraries; CLI keystore signs, no plaintext key input.
/// @dev This script is deliberately Arbitrum Sepolia only. No mainnet switch.
contract DeployV3Libraries is Script {
    address private constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    error V3Deploy__WrongChain();
    error V3Deploy__LibraryDeploymentFailed();
    event LibraryDeployed(string artifact, address deployed, bytes32 runtimeCodeHash, bytes32 initCodeHash);

    function run() external {
        if (block.chainid != 421614) revert V3Deploy__WrongChain();
        DeploymentRoles.validateBroadcaster(msg.sender);
        NetworkDeploymentConfig.preflightAccounts(NetworkDeploymentConfig.get(block.chainid));
        // Resolve artifacts before broadcast. Neither library contains unresolved links.
        bytes memory security = vm.getCode("src/v3/AccountV3Security.sol:AccountV3Security");
        bytes memory upgrade = vm.getCode("src/v3/AccountV3Upgrade.sol:AccountV3Upgrade");
        vm.startBroadcast();
        _deploy("AccountV3Security", security);
        _deploy("AccountV3Upgrade", upgrade);
        vm.stopBroadcast();
    }

    function _deploy(string memory name, bytes memory initCode) private {
        bytes32 salt = keccak256(abi.encode(V3Deployment.SALT, name));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        // Fail instead of trusting code left by a prior release at the predicted address.
        if (initCode.length == 0 || predicted.code.length != 0) revert V3Deploy__LibraryDeploymentFailed();
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        if (!success || predicted.code.length == 0) revert V3Deploy__LibraryDeploymentFailed();
        emit LibraryDeployed(name, predicted, predicted.codehash, keccak256(initCode));
        console.log(name, predicted);
        console.logBytes32(predicted.codehash);
    }
}

/// @notice Phase 2: compile with both --libraries links from the reviewed phase-1 receipt.
/// @dev Explicit expected hashes prevent Foundry's implicit library auto-deployment from
/// being mistaken for an admitted release. Output is evidence, not permission to enable payments.
contract DeployV3 is Script {
    error V3Deploy__WrongChain();
    error V3Deploy__UnreviewedLibraries();
    error V3Deploy__AddressMismatch();

    function run() external {
        if (block.chainid != 421614) revert V3Deploy__WrongChain();
        DeploymentRoles.validateBroadcaster(msg.sender);
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightAccounts(config);
        address security = vm.envAddress("GATOPAGO_V3_SECURITY_LIBRARY");
        address upgrade = vm.envAddress("GATOPAGO_V3_UPGRADE_LIBRARY");
        bytes32 securityHash = vm.envBytes32("GATOPAGO_V3_SECURITY_LIBRARY_CODEHASH");
        bytes32 upgradeHash = vm.envBytes32("GATOPAGO_V3_UPGRADE_LIBRARY_CODEHASH");
        if (
            security != address(AccountV3Security) || upgrade != address(AccountV3Upgrade) || security.code.length == 0
                || upgrade.code.length == 0 || security.codehash != securityHash || upgrade.codehash != upgradeHash
        ) {
            revert V3Deploy__UnreviewedLibraries();
        }
        vm.startBroadcast();
        V3Deployment.Stack memory stack = V3Deployment.deploy(config.entryPoint);
        vm.stopBroadcast();
        address predicted = vm.computeCreate2Address(
            V3Deployment.SALT, keccak256(abi.encodePacked(type(AccountV3).creationCode, abi.encode(config.entryPoint)))
        );
        if (predicted != address(stack.implementation)) revert V3Deploy__AddressMismatch();
        predicted = vm.computeCreate2Address(
            V3Deployment.SALT,
            keccak256(
                abi.encodePacked(
                    type(AccountFactoryV3).creationCode, abi.encode(address(stack.implementation), config.entryPoint)
                )
            )
        );
        if (predicted != address(stack.factory)) revert V3Deploy__AddressMismatch();
        predicted = vm.computeCreate2Address(V3Deployment.SALT, keccak256(type(AccountV3WebAuthnVerifier).creationCode));
        if (predicted != address(stack.verifier)) revert V3Deploy__AddressMismatch();
        console.log("Initial implementation", address(stack.implementation));
        console.log("Factory", address(stack.factory));
        console.log("WebAuthn verifier", address(stack.verifier));
        console.log("EntryPoint", config.entryPoint);
        // Current implementation is inspected per account; never overwrite initial identity.
        console.logBytes32(stack.factory.proxyInitCodeHash());
    }
}
