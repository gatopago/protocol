// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GatoPagoPaymentRouter} from "../src/GatoPagoPaymentRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {TestTokenMessenger} from "./mocks/TestTokenMessenger.sol";

contract TestToken is ERC20Permit {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) ERC20Permit(name) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract GatoPagoPaymentRouterTest is Test {
    uint32 internal constant ARBITRUM = 3;
    uint32 internal constant AVALANCHE = 1;

    TestToken internal usdc = new TestToken("USD Coin", "USDC");
    /// @dev Another coin of this network (AUSD on Monad): paid and received here only.
    TestToken internal ausd = new TestToken("Agora Dollar", "AUSD");
    TestTokenMessenger internal messenger = new TestTokenMessenger();
    uint256 internal signerKey = 0xA11CE;
    uint256 internal payerKey = 0xB0B;
    address internal payer = vm.addr(payerKey);
    address internal merchant = makeAddr("merchant");
    address internal treasury = makeAddr("treasury");
    GatoPagoPaymentRouter internal router =
        new GatoPagoPaymentRouter(address(this), vm.addr(signerKey), treasury, usdc, messenger, ARBITRUM);

    function setUp() public {
        usdc.mint(payer, 1_000e6);
        ausd.mint(payer, 1_000e6);
    }

    function _payment(uint32 destinationDomain) internal view returns (GatoPagoPaymentRouter.Payment memory) {
        return GatoPagoPaymentRouter.Payment({
            intentId: keccak256("pi_1"),
            payer: payer,
            merchant: merchant,
            token: address(usdc),
            amount: 100e6,
            fee: 1e6,
            destinationDomain: destinationDomain,
            maxCctpFee: 0.2e6,
            minFinalityThreshold: 1000,
            validUntil: uint48(block.timestamp + 300)
        });
    }

    function _sign(GatoPagoPaymentRouter.Payment memory payment, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, router.paymentDigest(payment));
        return abi.encodePacked(r, s, v);
    }

    function _pay(GatoPagoPaymentRouter.Payment memory payment) internal {
        vm.startPrank(payer);
        TestToken(payment.token).approve(address(router), router.total(payment));
        router.pay(payment, _sign(payment, signerKey));
        vm.stopPrank();
    }

    function test_paysTheMerchantAndTheFeeOnThisNetwork() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        bytes memory signature = _sign(payment, signerKey);
        vm.startPrank(payer);
        usdc.approve(address(router), router.total(payment));
        vm.expectEmit(address(router));
        emit GatoPagoPaymentRouter.PaymentSent(payment.intentId, payer, merchant, address(usdc), 100e6, 1e6, ARBITRUM);
        router.pay(payment, signature);
        vm.stopPrank();

        assertEq(usdc.balanceOf(merchant), 100e6);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 101e6);
        assertTrue(router.paid(payment.intentId));
    }

    function test_paysTheMerchantInAnotherCoinOfThisNetwork() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        payment.token = address(ausd);
        bytes memory signature = _sign(payment, signerKey);
        vm.startPrank(payer);
        ausd.approve(address(router), router.total(payment));
        vm.expectEmit(address(router));
        emit GatoPagoPaymentRouter.PaymentSent(payment.intentId, payer, merchant, address(ausd), 100e6, 1e6, ARBITRUM);
        router.pay(payment, signature);
        vm.stopPrank();

        assertEq(ausd.balanceOf(merchant), 100e6);
        assertEq(ausd.balanceOf(treasury), 1e6);
        assertEq(ausd.balanceOf(payer), 1_000e6 - 101e6);
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_onlyUsdcCrossesNetworks() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(AVALANCHE);
        payment.token = address(ausd);
        bytes memory signature = _sign(payment, signerKey);
        vm.startPrank(payer);
        ausd.approve(address(router), router.total(payment));
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__OnlyUsdcCrosses.selector);
        router.pay(payment, signature);
        vm.stopPrank();
        assertFalse(router.paid(payment.intentId));
    }

    function test_burnsThroughCctpWithForwardingToTheMerchantOnAnotherNetwork() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(AVALANCHE);
        assertEq(router.total(payment), 101.2e6);
        _pay(payment);

        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.allowance(address(router), address(messenger)), 0);
        assertEq(
            messenger.lastCall(),
            abi.encode(
                uint256(100.2e6),
                AVALANCHE,
                bytes32(uint256(uint160(merchant))),
                address(usdc),
                bytes32(0),
                uint256(0.2e6),
                uint32(1000),
                bytes(hex"636374702d666f72776172640000000000000000000000000000000000000000")
            )
        );
    }

    function test_paysInOneTransactionWithAPermit() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        uint256 deadline = block.timestamp + 300;
        bytes32 permit = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                payer,
                address(router),
                router.total(payment),
                usdc.nonces(payer),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), permit)));
        bytes memory signature = _sign(payment, signerKey);

        // Someone uses the permit first: the payment still goes through with the allowance it set.
        usdc.permit(payer, address(router), router.total(payment), deadline, v, r, s);
        vm.prank(payer);
        router.payWithPermit(payment, signature, deadline, v, r, s);
        assertEq(usdc.balanceOf(merchant), 100e6);
    }

    function test_rejectsAnotherCallerThanThePayer() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        bytes memory signature = _sign(payment, signerKey);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__NotPayer.selector);
        router.pay(payment, signature);
    }

    function test_rejectsAnExpiredAuthorization() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        bytes memory signature = _sign(payment, signerKey);
        vm.warp(payment.validUntil + 1);
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__Expired.selector);
        router.pay(payment, signature);
    }

    function test_rejectsAnIntentPaidTwice() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        _pay(payment);
        bytes memory signature = _sign(payment, signerKey);
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__AlreadyPaid.selector);
        router.pay(payment, signature);
    }

    function test_rejectsAPaymentFlowDidNotSign() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        bytes memory forged = _sign(payment, payerKey);
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidSignature.selector);
        router.pay(payment, forged);

        // Changing any signed field invalidates Flow's signature, the coin included.
        bytes memory signature = _sign(payment, signerKey);
        payment.amount = 1;
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidSignature.selector);
        router.pay(payment, signature);
        payment.amount = 100e6;
        payment.token = address(ausd);
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidSignature.selector);
        router.pay(payment, signature);
    }

    function test_ownerPausesAndRotatesTheSignerAndTreasury() public {
        GatoPagoPaymentRouter.Payment memory payment = _payment(ARBITRUM);
        bytes memory signature = _sign(payment, signerKey);
        router.pause();
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.pay(payment, signature);
        router.unpause();

        router.setSigner(vm.addr(0xCAFE));
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidSignature.selector);
        router.pay(payment, signature);

        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        router.setTreasury(payer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        router.pause();
        vm.stopPrank();
    }
}
