// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {GatoPagoPaymentRouter} from "src/GatoPagoPaymentRouter.sol";
import {GatoPagoCctpPaymentRouter} from "src/GatoPagoCctpPaymentRouter.sol";
import {GatoPagoCrosschainRouter} from "src/GatoPagoCrosschainRouter.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";

interface ISmokeUSDC is IERC20, IERC20Permit {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

abstract contract UniversalCheckoutSmokeScript is Script {
    uint256 internal constant DEFAULT_SMOKE_AMOUNT = 100_000; // 0.1 USDC
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    error Smoke__RouterHasNoCode(address router);
    error Smoke__UnexpectedUsdc(address expected, address actual);
    error Smoke__UnexpectedTokenMessenger(address expected, address actual);
    error Smoke__UnexpectedSettlementChain(uint256 expected, uint256 actual);
    error Smoke__UnexpectedFastCapability(bool expected, bool actual);
    error Smoke__UnexpectedPlatformFeeCap(uint256 actual);
    error Smoke__UnsupportedDestinationDomain(uint32 domain);
    error Smoke__SignerMustBeBroadcaster(address signer, address broadcaster);
    error Smoke__InsufficientUsdc(uint256 required, uint256 available);
    error Smoke__RouterRetainedFunds(uint256 balance);
    error Smoke__PaymentEvidenceMissing(bytes32 intentId, bytes32 attemptId);
    error Smoke__CrosschainEvidenceMissing(bytes32 opId);

    function _smokeContext(address routerAddress, address configuredUsdc)
        internal
        view
        returns (address payer, address merchant, uint256 amount, uint256 deadline, bytes32 intentId, bytes32 attemptId)
    {
        if (routerAddress.code.length == 0) revert Smoke__RouterHasNoCode(routerAddress);
        payer = msg.sender;
        merchant = vm.envOr("GATOPAGO_SMOKE_MERCHANT", payer);
        amount = vm.envOr("GATOPAGO_SMOKE_AMOUNT", DEFAULT_SMOKE_AMOUNT);
        deadline = block.timestamp + 1 hours;
        uint256 smokeNonce = vm.envOr("GATOPAGO_SMOKE_NONCE", block.number);
        intentId = keccak256(abi.encode("gatopago-smoke-intent", block.chainid, routerAddress, smokeNonce));
        attemptId = keccak256(abi.encode("gatopago-smoke-attempt", block.chainid, routerAddress, smokeNonce));

        uint256 available = IERC20(configuredUsdc).balanceOf(payer);
        if (available < amount) revert Smoke__InsufficientUsdc(amount, available);
    }

    function _permitSignature(ISmokeUSDC usdc, address payer, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, payer, spender, value, usdc.nonces(payer), deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        (v, r, s) = vm.sign(payer, digest);
    }

    function _authorizationSignature(address signer, bytes32 digest) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signer, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _assertEvidence(IERC20 usdc, address router, bool paid, bool used, bytes32 intentId, bytes32 attemptId)
        internal
        view
    {
        uint256 routerBalance = usdc.balanceOf(router);
        if (routerBalance != 0) revert Smoke__RouterRetainedFunds(routerBalance);
        if (!paid || !used) revert Smoke__PaymentEvidenceMissing(intentId, attemptId);
    }
}

/// @notice Broadcasts a minimal real USDC payment through the deployed Arbitrum router.
contract SmokePaymentRouter is UniversalCheckoutSmokeScript {
    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightLocalCheckout(config);
        address routerAddress = vm.envAddress("GATOPAGO_SMOKE_ROUTER");
        GatoPagoPaymentRouter router = GatoPagoPaymentRouter(routerAddress);
        if (address(router.USDC()) != config.usdc) {
            revert Smoke__UnexpectedUsdc(config.usdc, address(router.USDC()));
        }
        if (router.authorizationSigner() != msg.sender) {
            revert Smoke__SignerMustBeBroadcaster(router.authorizationSigner(), msg.sender);
        }

        (address payer, address merchant, uint256 amount, uint256 deadline, bytes32 intentId, bytes32 attemptId) =
            _smokeContext(routerAddress, config.usdc);
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = GatoPagoPaymentRouter.PaymentAuthorization({
            intentId: intentId,
            attemptId: attemptId,
            payer: payer,
            merchant: merchant,
            settlementAmount: amount,
            platformFee: 0,
            validAfter: uint48(block.timestamp),
            validUntil: SafeCast.toUint48(deadline),
            metadataHash: keccak256("gatopago-local-smoke")
        });
        bytes memory signature =
            _authorizationSignature(router.authorizationSigner(), router.authorizationDigest(authorization));
        (uint8 v, bytes32 r, bytes32 s) =
            _permitSignature(ISmokeUSDC(config.usdc), payer, routerAddress, amount, deadline);

        vm.startBroadcast();
        router.payWithPermit(authorization, signature, deadline, v, r, s);
        vm.stopBroadcast();

        _assertEvidence(
            IERC20(config.usdc),
            routerAddress,
            router.paidIntent(intentId),
            router.usedAttempt(attemptId),
            intentId,
            attemptId
        );
        console.log("Universal Checkout local smoke succeeded");
        console.logBytes32(intentId);
        console.logBytes32(attemptId);
    }
}

/// @notice Broadcasts a real Standard outbound burn through the hardened router
///         on Arbitrum Sepolia. Base Sepolia (domain 6) is the default target.
contract SmokeCrosschainRouter is UniversalCheckoutSmokeScript {
    uint32 private constant DEFAULT_DESTINATION_DOMAIN = 6;

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireHomeChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address routerAddress = vm.envAddress("GATOPAGO_SMOKE_ROUTER");
        GatoPagoCrosschainRouter router = GatoPagoCrosschainRouter(routerAddress);
        if (routerAddress.code.length == 0) revert Smoke__RouterHasNoCode(routerAddress);
        if (address(router.USDC()) != config.usdc) {
            revert Smoke__UnexpectedUsdc(config.usdc, address(router.USDC()));
        }
        if (address(router.TOKEN_MESSENGER()) != config.tokenMessenger) {
            revert Smoke__UnexpectedTokenMessenger(config.tokenMessenger, address(router.TOKEN_MESSENGER()));
        }

        (address payer, address merchant, uint256 amount, uint256 deadline,, bytes32 opId) =
            _smokeContext(routerAddress, config.usdc);
        uint32 destinationDomain =
            SafeCast.toUint32(vm.envOr("GATOPAGO_SMOKE_DESTINATION_DOMAIN", uint256(DEFAULT_DESTINATION_DOMAIN)));
        if (!router.supportedDestinationDomain(destinationDomain)) {
            revert Smoke__UnsupportedDestinationDomain(destinationDomain);
        }

        (uint8 v, bytes32 r, bytes32 s) =
            _permitSignature(ISmokeUSDC(config.usdc), payer, routerAddress, amount, deadline);

        vm.startBroadcast();
        ISmokeUSDC(config.usdc).permit(payer, routerAddress, amount, deadline, v, r, s);
        router.bridgeUSDC(
            opId, amount, 0, destinationDomain, bytes32(uint256(uint160(merchant))), 0, router.STANDARD_FINALITY()
        );
        vm.stopBroadcast();

        uint256 routerBalance = IERC20(config.usdc).balanceOf(routerAddress);
        if (routerBalance != 0) revert Smoke__RouterRetainedFunds(routerBalance);
        if (!router.usedOpId(payer, opId)) revert Smoke__CrosschainEvidenceMissing(opId);

        console.log("Hardened outbound CCTP smoke succeeded");
        console.logBytes32(opId);
    }
}

/// @notice Broadcasts a Standard CCTP payment from Base Sepolia or Fuji.
contract SmokeCctpPaymentRouter is UniversalCheckoutSmokeScript {
    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireInboundSourceChain(config);
        NetworkDeploymentConfig.preflightCctp(config);
        address routerAddress = vm.envAddress("GATOPAGO_SMOKE_ROUTER");
        GatoPagoCctpPaymentRouter router = GatoPagoCctpPaymentRouter(routerAddress);
        if (address(router.USDC()) != config.usdc) {
            revert Smoke__UnexpectedUsdc(config.usdc, address(router.USDC()));
        }
        if (address(router.TOKEN_MESSENGER()) != config.tokenMessenger) {
            revert Smoke__UnexpectedTokenMessenger(config.tokenMessenger, address(router.TOKEN_MESSENGER()));
        }
        if (router.SETTLEMENT_CHAIN_ID() != config.settlementChainId) {
            revert Smoke__UnexpectedSettlementChain(config.settlementChainId, router.SETTLEMENT_CHAIN_ID());
        }
        if (router.FAST_TRANSFER_ENABLED() != config.cctpFastSupported) {
            revert Smoke__UnexpectedFastCapability(config.cctpFastSupported, router.FAST_TRANSFER_ENABLED());
        }
        if (router.MAX_PLATFORM_FEE_BPS() != config.cctpPaymentPlatformFeeCapBps) {
            revert Smoke__UnexpectedPlatformFeeCap(router.MAX_PLATFORM_FEE_BPS());
        }
        if (router.authorizationSigner() != msg.sender) {
            revert Smoke__SignerMustBeBroadcaster(router.authorizationSigner(), msg.sender);
        }

        (address payer, address merchant, uint256 amount, uint256 deadline, bytes32 intentId, bytes32 attemptId) =
            _smokeContext(routerAddress, config.usdc);
        GatoPagoCctpPaymentRouter.CctpPaymentAuthorization memory authorization =
            GatoPagoCctpPaymentRouter.CctpPaymentAuthorization({
                intentId: intentId,
                attemptId: attemptId,
                payer: payer,
                merchant: merchant,
                settlementChainId: config.settlementChainId,
                destinationDomain: 3,
                settlementAmount: amount,
                grossPayerAmount: amount,
                platformFee: 0,
                maxCctpFee: 0,
                minFinalityThreshold: 2000,
                validAfter: uint48(block.timestamp),
                validUntil: SafeCast.toUint48(deadline),
                metadataHash: keccak256("gatopago-cctp-smoke")
            });
        bytes memory signature =
            _authorizationSignature(router.authorizationSigner(), router.authorizationDigest(authorization));
        (uint8 v, bytes32 r, bytes32 s) =
            _permitSignature(ISmokeUSDC(config.usdc), payer, routerAddress, amount, deadline);

        vm.startBroadcast();
        router.payWithPermit(authorization, signature, deadline, v, r, s);
        vm.stopBroadcast();

        _assertEvidence(
            IERC20(config.usdc),
            routerAddress,
            router.paidIntent(intentId),
            router.usedAttempt(attemptId),
            intentId,
            attemptId
        );
        console.log("Universal Checkout CCTP smoke succeeded");
        console.logBytes32(intentId);
        console.logBytes32(attemptId);
    }
}
