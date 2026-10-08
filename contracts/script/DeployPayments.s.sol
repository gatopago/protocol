// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GatoPagoPaymentRouter} from "../src/GatoPagoPaymentRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";

/// @notice Deploys Flow's payment router through the standard CREATE2 deployer. Idempotent: an
/// existing router with the same settings is reused.
///
///   GATOPAGO_PAYMENTS_OWNER=0x… GATOPAGO_PAYMENTS_SIGNER=0x… GATOPAGO_PAYMENTS_TREASURY=0x… \
///   forge script script/DeployPayments.s.sol --rpc-url <network> --account <keystore> --broadcast \
///     --verify --verifier sourcify
contract DeployPayments is Script {
    bytes32 internal constant SALT = keccak256("gatopago.payments.v1");
    /// @dev Circle's CCTP V2 TokenMessenger on every testnet.
    address internal constant TESTNET_TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    error DeployPayments__UnsupportedNetwork(uint256 chainId);
    error DeployPayments__CreationFailed(address expected);

    function run() external returns (address router) {
        (address usdc, uint32 domain) = _network();
        bytes memory initCode = abi.encodePacked(
            type(GatoPagoPaymentRouter).creationCode,
            abi.encode(
                vm.envAddress("GATOPAGO_PAYMENTS_OWNER"),
                vm.envAddress("GATOPAGO_PAYMENTS_SIGNER"),
                vm.envAddress("GATOPAGO_PAYMENTS_TREASURY"),
                IERC20(usdc),
                ITokenMessengerV2(TESTNET_TOKEN_MESSENGER),
                domain
            )
        );
        router = vm.computeCreate2Address(SALT, keccak256(initCode));
        if (router.code.length == 0) {
            vm.broadcast();
            (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, initCode));
            if (!success || router.code.length == 0) revert DeployPayments__CreationFailed(router);
        }
        console.log("GatoPagoPaymentRouter:", router);
    }

    /// @dev Circle USDC and CCTP domain of each network (same as `@gatopago/shared/networks`).
    function _network() private view returns (address usdc, uint32 domain) {
        if (block.chainid == 421614) return (0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, 3);
        if (block.chainid == 43113) return (0x5425890298aed601595a70AB815c96711a31Bc65, 1);
        if (block.chainid == 10143) return (0x534b2f3A21130d7a60830c2Df862319e593943A3, 15);
        revert DeployPayments__UnsupportedNetwork(block.chainid);
    }
}
