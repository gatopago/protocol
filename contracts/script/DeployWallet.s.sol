// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {
    ERC7913WebAuthnVerifier
} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";
import {GatoPagoAccountFactory} from "../src/wallet/GatoPagoAccountFactory.sol";
import {GatoPagoPaymaster} from "../src/wallet/GatoPagoPaymaster.sol";

/// @notice Deploys the wallet contracts through the standard CREATE2 deployer, so they share
/// addresses on every network (and every user keeps one account address). Idempotent: contracts
/// already deployed are reused, which is how a new network is added.
///
///   GATOPAGO_SPONSOR_SIGNER=0x… GATOPAGO_PAYMASTER_OWNER=0x… [GATOPAGO_PAYMASTER_DEPOSIT=wei] \
///   forge script script/DeployWallet.s.sol --rpc-url <network> --account <keystore> --broadcast \
///     --verify --verifier sourcify
///
/// The sponsor signer and paymaster owner are part of the paymaster address: keep them identical
/// across networks.
contract DeployWallet is Script {
    bytes32 internal constant SALT = keccak256("gatopago.wallet.v1");

    error DeployWallet__CreationFailed(address expected);

    function run() external returns (address verifier, address factory, address paymaster) {
        address sponsorSigner = vm.envAddress("GATOPAGO_SPONSOR_SIGNER");
        address paymasterOwner = vm.envAddress("GATOPAGO_PAYMASTER_OWNER");
        uint256 deposit = vm.envOr("GATOPAGO_PAYMASTER_DEPOSIT", uint256(0));

        vm.startBroadcast();
        verifier = _deploy(type(ERC7913WebAuthnVerifier).creationCode);
        factory = _deploy(type(GatoPagoAccountFactory).creationCode);
        paymaster =
            _deploy(abi.encodePacked(type(GatoPagoPaymaster).creationCode, abi.encode(sponsorSigner, paymasterOwner)));
        if (deposit != 0) GatoPagoPaymaster(paymaster).deposit{value: deposit}();
        vm.stopBroadcast();

        console.log("ERC7913WebAuthnVerifier:", verifier);
        console.log("GatoPagoAccountFactory: ", factory);
        console.log("GatoPagoPaymaster:      ", paymaster);
    }

    function _deploy(bytes memory initCode) private returns (address deployed) {
        deployed = vm.computeCreate2Address(SALT, keccak256(initCode));
        if (deployed.code.length != 0) return deployed;
        (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
        if (!success || deployed.code.length == 0) revert DeployWallet__CreationFailed(deployed);
    }
}
