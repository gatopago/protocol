// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {GatoPagoCctpPaymentRouter} from "../src/GatoPagoCctpPaymentRouter.sol";
import {GatoPagoCrosschainRouter} from "../src/GatoPagoCrosschainRouter.sol";
import {GatoPagoPaymentRouter} from "../src/GatoPagoPaymentRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {DeploymentRoles} from "./DeploymentRoles.sol";
import {NetworkDeploymentConfig} from "./NetworkDeploymentConfig.sol";

/**
 * @notice Shared helpers for deterministic GatoPago deployments.
 * @dev Signing is deliberately delegated to Foundry CLI accounts/keystores.
 *      No deployment script reads or accepts a plaintext private key.
 */
abstract contract GatoPagoDeploymentScript is Script {
    struct RouterRoles {
        address owner;
        address treasury;
        address authorizationSigner;
        address pauseGuardian;
    }

    error Deploy__PredictedAddressMismatch(address predicted, address actual);
    error Deploy__ValueDoesNotFitUint16(uint256 value);
    error Deploy__ValueDoesNotFitUint32(uint256 value);

    function _routerRoles(address deployer) internal view returns (RouterRoles memory roles) {
        roles.owner = vm.envOr("GATOPAGO_CONTRACT_OWNER", deployer);
        roles.treasury = vm.envOr("GATOPAGO_TREASURY", deployer);
        roles.authorizationSigner = vm.envOr("GATOPAGO_PAYMENT_ROUTER_SIGNER", deployer);
        roles.pauseGuardian = vm.envOr("GATOPAGO_PAUSE_GUARDIAN", roles.owner);
    }

    function _assertPredicted(bytes32 salt, bytes memory creationCode, address actual) internal pure {
        address predicted = vm.computeCreate2Address(salt, keccak256(creationCode));
        if (predicted != actual) revert Deploy__PredictedAddressMismatch(predicted, actual);
    }
}

/// @notice Deploys Universal Checkout's same-chain USDC router on Arbitrum.
contract DeployPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.payment-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightLocalCheckout(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoPaymentRouter).creationCode,
            abi.encode(roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian)
        );

        vm.startBroadcast();
        GatoPagoPaymentRouter router = new GatoPagoPaymentRouter{salt: SALT}(
            roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoPaymentRouter:", address(router));
        console.log("chainId:                 ", block.chainid);
        console.log("USDC:                    ", config.usdc);
        console.log("owner:                   ", roles.owner);
        console.log("treasury:                ", roles.treasury);
        console.log("authorization signer:    ", roles.authorizationSigner);
        console.log("pause guardian:          ", roles.pauseGuardian);
    }
}

/// @notice Deploys Universal Checkout's Base/Avalanche to Arbitrum CCTP rail.
contract DeployCctpPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.cctp-payment-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireInboundSourceChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        // Capability is not policy: the backend remains free by default. A bounded
        // non-zero ceiling avoids a contract redeploy if an explicit future policy
        // enables fees for a narrow transaction class.
        uint256 configuredFeeCap =
            vm.envOr("GATOPAGO_CCTP_PLATFORM_FEE_CAP_BPS", uint256(config.cctpPaymentPlatformFeeCapBps));
        if (configuredFeeCap > type(uint16).max) revert Deploy__ValueDoesNotFitUint16(configuredFeeCap);
        uint16 feeCap = SafeCast.toUint16(configuredFeeCap);

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoCctpPaymentRouter).creationCode,
            abi.encode(
                roles.owner,
                IERC20(config.usdc),
                ITokenMessengerV2(config.tokenMessenger),
                roles.treasury,
                roles.authorizationSigner,
                roles.pauseGuardian,
                config.settlementChainId,
                config.cctpFastSupported,
                feeCap
            )
        );

        vm.startBroadcast();
        GatoPagoCctpPaymentRouter router = new GatoPagoCctpPaymentRouter{salt: SALT}(
            roles.owner,
            IERC20(config.usdc),
            ITokenMessengerV2(config.tokenMessenger),
            roles.treasury,
            roles.authorizationSigner,
            roles.pauseGuardian,
            config.settlementChainId,
            config.cctpFastSupported,
            feeCap
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoCctpPaymentRouter:", address(router));
        console.log("source chainId:            ", block.chainid);
        console.log("settlement chainId:        ", config.settlementChainId);
        console.log("destination domain:        ", uint256(router.ARBITRUM_DOMAIN()));
        console.log("fast transfer enabled:     ", config.cctpFastSupported);
        console.log("platform fee cap bps:      ", uint256(feeCap));
        console.log("USDC:                      ", config.usdc);
        console.log("TokenMessengerV2:          ", config.tokenMessenger);
    }
}

/// @notice Deploys the hardened outbound CCTP router on the Arbitrum home chain.
contract DeployCrosschainRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.v3.crosschain-router.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireCrosschainRouterChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", deployer);
        address treasury = vm.envOr("GATOPAGO_TREASURY", deployer);
        DeploymentRoles.validateCrosschainRouter(block.chainid, deployer, finalOwner, treasury);
        uint32[] memory domains = NetworkDeploymentConfig.outboundDomains(config);

        bytes memory creationCode = abi.encodePacked(
            type(GatoPagoCrosschainRouter).creationCode,
            abi.encode(finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains)
        );

        vm.startBroadcast();
        GatoPagoCrosschainRouter router = new GatoPagoCrosschainRouter{salt: SALT}(
            finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("GatoPagoCrosschainRouter:", address(router));
        console.log("chainId:                  ", block.chainid);
        console.log("treasury:                 ", treasury);
        console.log("USDC:                     ", config.usdc);
        console.log("TokenMessengerV2:         ", config.tokenMessenger);
    }
}
