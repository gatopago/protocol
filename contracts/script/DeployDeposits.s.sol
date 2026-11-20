// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {CascabelDepositFactory} from "../src/deposits/CascabelDepositFactory.sol";

/// @notice Deploys Cascabel's deposit factory through the standard CREATE2 deployer. It has no
/// constructor arguments, so it lands at the same address on every network (and so does every
/// deposit). Idempotent: an existing factory is reused. On a network outside `CascabelNetworks`,
/// deploying it lets what was paid there by mistake be swept to each settlement's `localRecipient`.
///
///   forge script script/DeployDeposits.s.sol --rpc-url <network> --account <keystore> --broadcast \
///     --verify --verifier sourcify
contract DeployDeposits is Script {
    bytes32 internal constant SALT = keccak256("cascabel.deposits.v1");

    error DeployDeposits__CreationFailed(address expected);

    function run() external returns (address factory) {
        bytes memory initCode = type(CascabelDepositFactory).creationCode;
        factory = vm.computeCreate2Address(SALT, keccak256(initCode));
        if (factory.code.length == 0) {
            vm.broadcast();
            (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
            if (!success || factory.code.length == 0) revert DeployDeposits__CreationFailed(factory);
        }
        console.log("CascabelDepositFactory:", factory);
        console.log("CascabelDeposit implementation:", CascabelDepositFactory(factory).implementation());
    }
}
