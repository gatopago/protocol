// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {GatoPagoPaymentRouter} from "src/GatoPagoPaymentRouter.sol";
import {GatoPagoCctpPaymentRouter} from "src/GatoPagoCctpPaymentRouter.sol";
import {ITokenMessengerV2} from "src/interfaces/ITokenMessengerV2.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";

interface IForkUSDC is IERC20, IERC20Permit {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * @notice State-changing fork proofs against Circle's real testnet USDC/CCTP.
 * @dev These tests skip during ordinary unit runs. Set the three RPC variables
 *      to prove permit compatibility and the complete router call on every
 *      Universal Checkout v1 source network.
 */
contract UniversalCheckoutForkTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant PAYER_KEY = 0xBEEF1234;
    uint256 internal constant ONE_USDC = 1e6;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    address internal authorizationSigner;
    address internal payer;
    address internal merchant;
    address internal treasury;

    function setUp() public {
        authorizationSigner = vm.addr(SIGNER_KEY);
        payer = vm.addr(PAYER_KEY);
        merchant = makeAddr("fork merchant");
        treasury = makeAddr("fork treasury");
    }

    function test_arbitrumSepolia_localRouterPayWithPermit() public {
        _selectFork("ARBITRUM_SEPOLIA_RPC_URL");
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightLocalCheckout(config);
        assertTrue(config.isHomeChain);

        IForkUSDC usdc = IForkUSDC(config.usdc);
        GatoPagoPaymentRouter router = new GatoPagoPaymentRouter(
            makeAddr("fork owner"), IERC20(config.usdc), treasury, authorizationSigner, makeAddr("fork guardian")
        );
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = GatoPagoPaymentRouter.PaymentAuthorization({
            intentId: keccak256("fork-local-intent"),
            attemptId: keccak256("fork-local-attempt"),
            payer: payer,
            merchant: merchant,
            settlementAmount: 10 * ONE_USDC,
            platformFee: ONE_USDC / 100,
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 1 hours),
            metadataHash: keccak256("fork-local-metadata")
        });
        uint256 totalPayerAmount = authorization.settlementAmount + authorization.platformFee;
        deal(config.usdc, payer, totalPayerAmount);

        bytes memory authorizationSignature = _signAuthorization(router.authorizationDigest(authorization));
        (uint8 v, bytes32 r, bytes32 s) =
            _signPermit(usdc, address(router), totalPayerAmount, block.timestamp + 1 hours);

        vm.prank(payer);
        router.payWithPermit(authorization, authorizationSignature, block.timestamp + 1 hours, v, r, s);

        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.balanceOf(merchant), authorization.settlementAmount);
        assertEq(usdc.balanceOf(treasury), authorization.platformFee);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(router.usedAttempt(authorization.attemptId));
        assertTrue(router.paidIntent(authorization.intentId));
        assertEq(usdc.nonces(payer), 1);
    }

    function test_baseSepolia_cctpRouterPayWithPermit() public {
        _runCctpFork("BASE_SEPOLIA_RPC_URL", true, "base-sepolia");
    }

    function test_avalancheFuji_cctpRouterPayWithPermit() public {
        _runCctpFork("AVALANCHE_FUJI_RPC_URL", false, "avalanche-fuji");
    }

    function _runCctpFork(string memory rpcVariable, bool expectedFastCapability, string memory seed) private {
        _selectFork(rpcVariable);
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightCctp(config);
        NetworkDeploymentConfig.requireInboundSourceChain(config);
        assertEq(config.cctpFastSupported, expectedFastCapability);

        IForkUSDC usdc = IForkUSDC(config.usdc);
        GatoPagoCctpPaymentRouter router = new GatoPagoCctpPaymentRouter(
            makeAddr(string.concat(seed, " owner")),
            IERC20(config.usdc),
            ITokenMessengerV2(config.tokenMessenger),
            treasury,
            authorizationSigner,
            makeAddr(string.concat(seed, " guardian")),
            config.settlementChainId,
            config.cctpFastSupported,
            0
        );
        GatoPagoCctpPaymentRouter.CctpPaymentAuthorization memory authorization =
            GatoPagoCctpPaymentRouter.CctpPaymentAuthorization({
                intentId: keccak256(abi.encode(seed, " intent")),
                attemptId: keccak256(abi.encode(seed, " attempt")),
                payer: payer,
                merchant: merchant,
                settlementChainId: config.settlementChainId,
                destinationDomain: 3,
                settlementAmount: 10 * ONE_USDC,
                grossPayerAmount: 10 * ONE_USDC,
                platformFee: 0,
                maxCctpFee: 0,
                minFinalityThreshold: 2000,
                validAfter: uint48(block.timestamp),
                validUntil: uint48(block.timestamp + 1 hours),
                metadataHash: keccak256(abi.encode(seed, " metadata"))
            });
        deal(config.usdc, payer, authorization.grossPayerAmount);

        bytes memory authorizationSignature = _signAuthorization(router.authorizationDigest(authorization));
        (uint8 v, bytes32 r, bytes32 s) =
            _signPermit(usdc, address(router), authorization.grossPayerAmount, block.timestamp + 1 hours);

        vm.prank(payer);
        router.payWithPermit(authorization, authorizationSignature, block.timestamp + 1 hours, v, r, s);

        assertEq(usdc.balanceOf(payer), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertTrue(router.usedAttempt(authorization.attemptId));
        assertTrue(router.paidIntent(authorization.intentId));
        assertEq(usdc.nonces(payer), 1);
    }

    function _signAuthorization(bytes32 digest) private pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _signPermit(IForkUSDC usdc, address spender, uint256 value, uint256 deadline)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, payer, spender, value, usdc.nonces(payer), deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        (v, r, s) = vm.sign(PAYER_KEY, digest);
    }

    function _selectFork(string memory rpcVariable) private {
        string memory rpcUrl = vm.envOr(rpcVariable, string(""));
        vm.skip(bytes(rpcUrl).length == 0, string.concat("set ", rpcVariable, " to run this fork proof"));
        vm.createSelectFork(rpcUrl);
    }
}
