// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GatoPagoPaymentRouter} from "src/GatoPagoPaymentRouter.sol";

contract MockCheckoutUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Mock Checkout USDC", "USDC") ERC20Permit("Mock Checkout USDC") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract GatoPagoPaymentRouterTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant AUTHORIZATION_SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant PAYER_KEY = 0xBEEF1234;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchant = makeAddr("merchant");
    address internal pauseGuardian = makeAddr("pauseGuardian");
    address internal attacker = makeAddr("attacker");
    address internal authorizationSigner;
    address internal payer;

    MockCheckoutUSDC internal usdc;
    GatoPagoPaymentRouter internal router;

    event PaymentSettled(
        bytes32 indexed intentId,
        bytes32 indexed attemptId,
        address indexed payer,
        address merchant,
        uint256 settlementAmount,
        uint256 platformFee,
        bytes32 metadataHash
    );

    function setUp() public {
        authorizationSigner = vm.addr(AUTHORIZATION_SIGNER_KEY);
        payer = vm.addr(PAYER_KEY);
        usdc = new MockCheckoutUSDC();
        router = new GatoPagoPaymentRouter(owner, IERC20(address(usdc)), treasury, authorizationSigner, pauseGuardian);
        usdc.mint(payer, 1_000 * ONE_USDC);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_pay_settlesExactNetAmountAndFee() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("exact");
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);

        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentSettled(
            authorization.intentId,
            authorization.attemptId,
            payer,
            merchant,
            authorization.settlementAmount,
            authorization.platformFee,
            authorization.metadataHash
        );
        vm.prank(payer);
        router.pay(authorization, signature);

        assertEq(usdc.balanceOf(merchant), authorization.settlementAmount);
        assertEq(usdc.balanceOf(treasury), authorization.platformFee);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(router.usedAttempt(authorization.attemptId));
        assertTrue(router.paidIntent(authorization.intentId));
    }

    function test_pay_revertsWhenAttemptIsReplayed() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("replay-attempt");
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);
        _pay(authorization, signature);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__AttemptAlreadyUsed.selector, authorization.attemptId
            )
        );
        router.pay(authorization, signature);
    }

    function test_pay_revertsWhenIntentHasAnotherAttempt() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory first = _authorization("paid-intent");
        _pay(first, _sign(first, AUTHORIZATION_SIGNER_KEY));

        GatoPagoPaymentRouter.PaymentAuthorization memory second = first;
        second.attemptId = keccak256("another-attempt");
        bytes memory secondSignature = _sign(second, AUTHORIZATION_SIGNER_KEY);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__IntentAlreadyPaid.selector, first.intentId
            )
        );
        router.pay(second, secondSignature);
    }

    function test_pay_revertsForDifferentCallerWithoutConsumingAttempt() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("payer-bound");
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__UnauthorizedPayer.selector, attacker, payer
            )
        );
        router.pay(authorization, signature);

        assertFalse(router.usedAttempt(authorization.attemptId));
        assertFalse(router.paidIntent(authorization.intentId));
    }

    function test_pay_rejectsEveryTamperedEconomicField() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory original = _authorization("tamper");
        bytes memory signature = _sign(original, AUTHORIZATION_SIGNER_KEY);

        GatoPagoPaymentRouter.PaymentAuthorization memory changed = _authorization("tamper");
        changed.merchant = attacker;
        _expectInvalidAuthorization(changed, signature);

        changed = _authorization("tamper");
        changed.settlementAmount += 1;
        _expectInvalidAuthorization(changed, signature);

        changed = _authorization("tamper");
        changed.platformFee += 1;
        _expectInvalidAuthorization(changed, signature);

        changed = _authorization("tamper");
        changed.metadataHash = keccak256("different-metadata");
        _expectInvalidAuthorization(changed, signature);

        changed = _authorization("tamper");
        changed.validUntil += 1;
        _expectInvalidAuthorization(changed, signature);

        _pay(_authorization("tamper"), signature);
    }

    function test_pay_rejectsSignatureForAnotherChainAndRouter() public {
        vm.chainId(31337);
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("domain");
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);

        vm.chainId(31338);
        _expectInvalidAuthorization(authorization, signature);
        vm.chainId(31337);

        GatoPagoPaymentRouter anotherRouter =
            new GatoPagoPaymentRouter(owner, IERC20(address(usdc)), treasury, authorizationSigner, pauseGuardian);
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAuthorization.selector);
        anotherRouter.pay(authorization, signature);
    }

    function test_pay_rejectsMalformedOrWrongSignerSignature() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("bad-signature");

        _expectInvalidAuthorization(authorization, hex"1234");
        _expectInvalidAuthorization(authorization, _sign(authorization, 0xBADBEEF));
    }

    function test_pay_revertsBeforeAndAfterAuthorizationWindow() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("window");
        authorization.validAfter = uint48(block.timestamp + 10);
        authorization.validUntil = uint48(block.timestamp + 20);
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__AuthorizationNotActive.selector,
                authorization.validAfter
            )
        );
        router.pay(authorization, signature);

        vm.warp(uint256(authorization.validUntil) + 1);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__AuthorizationExpired.selector, authorization.validUntil
            )
        );
        router.pay(authorization, signature);
    }

    function test_pay_revertsInvalidWindow() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("invalid-window");
        authorization.validAfter = uint48(block.timestamp + 2);
        authorization.validUntil = uint48(block.timestamp + 1);

        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAuthorizationWindow.selector);
        router.pay(authorization, new bytes(65));
    }

    function test_pay_revertsFeeAboveHardCap() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("fee-cap");
        uint256 maximum = authorization.settlementAmount / 100;
        authorization.platformFee = maximum + 1;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__PlatformFeeTooHigh.selector,
                authorization.platformFee,
                maximum
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_revertsInvalidIdentifiersAddressesAndAmount() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("guards");

        authorization.intentId = bytes32(0);
        _expectRawRevert(authorization, GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidIntentId.selector);

        authorization = _authorization("guards-attempt");
        authorization.attemptId = bytes32(0);
        _expectRawRevert(authorization, GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAttemptId.selector);

        authorization = _authorization("guards-payer");
        authorization.payer = address(0);
        _expectRawRevert(authorization, GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidPayer.selector);

        authorization = _authorization("guards-merchant");
        authorization.merchant = address(0);
        _expectRawRevert(authorization, GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidMerchant.selector);

        authorization = _authorization("guards-amount");
        authorization.settlementAmount = 0;
        _expectRawRevert(authorization, GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAmount.selector);
    }

    function test_payWithPermit_settlesWithoutPriorAllowance() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("permit");
        bytes memory authorizationSignature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);
        uint256 permitDeadline = block.timestamp + 10 minutes;
        uint256 total = authorization.settlementAmount + authorization.platformFee;

        vm.prank(payer);
        usdc.approve(address(router), 0);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(total, permitDeadline);

        vm.prank(payer);
        router.payWithPermit(authorization, authorizationSignature, permitDeadline, v, r, s);

        assertEq(usdc.balanceOf(merchant), authorization.settlementAmount);
        assertEq(usdc.allowance(payer, address(router)), 0);
    }

    function test_payWithPermit_toleratesConsumedPermitWhenAllowanceExists() public {
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("permit-fallback");
        bytes memory authorizationSignature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);

        vm.prank(payer);
        router.payWithPermit(
            authorization, authorizationSignature, block.timestamp + 10 minutes, 27, bytes32(0), bytes32(0)
        );

        assertEq(usdc.balanceOf(merchant), authorization.settlementAmount);
    }

    function test_pauseGuardianCanPauseButOnlyOwnerCanUnpause() public {
        vm.prank(pauseGuardian);
        router.pause();
        assertTrue(router.paused());

        vm.prank(pauseGuardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauseGuardian));
        router.unpause();

        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());
    }

    function test_attackerCannotPauseAndPausedRouterRejectsPayment() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoPaymentRouter.GatoPagoPaymentRouter__UnauthorizedPause.selector, attacker
            )
        );
        router.pause();

        vm.prank(owner);
        router.pause();
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("paused");
        bytes memory signature = _sign(authorization, AUTHORIZATION_SIGNER_KEY);
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.pay(authorization, signature);
    }

    function test_ownerRotatesOperationalRoles() public {
        address nextTreasury = makeAddr("nextTreasury");
        address nextSigner = makeAddr("nextSigner");
        address nextGuardian = makeAddr("nextGuardian");

        vm.startPrank(owner);
        router.setTreasury(nextTreasury);
        router.setAuthorizationSigner(nextSigner);
        router.setPauseGuardian(nextGuardian);
        vm.stopPrank();

        assertEq(router.treasury(), nextTreasury);
        assertEq(router.authorizationSigner(), nextSigner);
        assertEq(router.pauseGuardian(), nextGuardian);
    }

    function test_adminFunctionsRejectNonOwnerAndZeroRoles() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        router.setTreasury(attacker);

        vm.startPrank(owner);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidTreasury.selector);
        router.setTreasury(address(0));
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAuthorizationSigner.selector);
        router.setAuthorizationSigner(address(0));
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidPauseGuardian.selector);
        router.setPauseGuardian(address(0));
        vm.stopPrank();
    }

    function test_rescueTokenOnlyRecoversAccidentalBalance() public {
        uint256 amount = 7 * ONE_USDC;
        usdc.mint(address(router), amount);

        vm.prank(owner);
        router.rescueToken(IERC20(address(usdc)), owner, amount);

        assertEq(usdc.balanceOf(owner), amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_constructorRejectsInvalidDependenciesAndRoles() public {
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidToken.selector);
        new GatoPagoPaymentRouter(owner, IERC20(address(0)), treasury, authorizationSigner, pauseGuardian);

        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidTreasury.selector);
        new GatoPagoPaymentRouter(owner, IERC20(address(usdc)), address(0), authorizationSigner, pauseGuardian);

        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAuthorizationSigner.selector);
        new GatoPagoPaymentRouter(owner, IERC20(address(usdc)), treasury, address(0), pauseGuardian);

        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidPauseGuardian.selector);
        new GatoPagoPaymentRouter(owner, IERC20(address(usdc)), treasury, authorizationSigner, address(0));
    }

    function testFuzz_payConservesFundsAndRouterRetainsNothing(uint256 settlementAmount, uint256 feeBps) public {
        settlementAmount = bound(settlementAmount, 1, 1e30);
        feeBps = bound(feeBps, 0, router.MAX_PLATFORM_FEE_BPS());
        uint256 platformFee = (settlementAmount * feeBps) / 10_000;
        uint256 total = settlementAmount + platformFee;
        usdc.mint(payer, total);

        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = _authorization("fuzz");
        authorization.intentId = keccak256(abi.encode("intent", settlementAmount, feeBps));
        authorization.attemptId = keccak256(abi.encode("attempt", settlementAmount, feeBps));
        authorization.settlementAmount = settlementAmount;
        authorization.platformFee = platformFee;

        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 merchantBefore = usdc.balanceOf(merchant);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        _pay(authorization, _sign(authorization, AUTHORIZATION_SIGNER_KEY));

        assertEq(payerBefore - usdc.balanceOf(payer), total);
        assertEq(usdc.balanceOf(merchant) - merchantBefore, settlementAmount);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, platformFee);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function _authorization(string memory seed)
        internal
        view
        returns (GatoPagoPaymentRouter.PaymentAuthorization memory authorization)
    {
        authorization = GatoPagoPaymentRouter.PaymentAuthorization({
            intentId: keccak256(abi.encode("intent", seed)),
            attemptId: keccak256(abi.encode("attempt", seed)),
            payer: payer,
            merchant: merchant,
            settlementAmount: 100 * ONE_USDC,
            platformFee: ONE_USDC / 2,
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 10 minutes),
            metadataHash: keccak256(abi.encode("metadata", seed))
        });
    }

    function _sign(GatoPagoPaymentRouter.PaymentAuthorization memory authorization, uint256 signerKey)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 digest = router.authorizationDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _signPermit(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 typeHash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, payer, address(router), value, usdc.nonces(payer), deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        return vm.sign(PAYER_KEY, digest);
    }

    function _pay(GatoPagoPaymentRouter.PaymentAuthorization memory authorization, bytes memory signature) internal {
        vm.prank(payer);
        router.pay(authorization, signature);
    }

    function _expectInvalidAuthorization(
        GatoPagoPaymentRouter.PaymentAuthorization memory authorization,
        bytes memory signature
    ) internal {
        vm.prank(payer);
        vm.expectRevert(GatoPagoPaymentRouter.GatoPagoPaymentRouter__InvalidAuthorization.selector);
        router.pay(authorization, signature);
    }

    function _expectRawRevert(GatoPagoPaymentRouter.PaymentAuthorization memory authorization, bytes4 selector)
        internal
    {
        vm.prank(payer);
        vm.expectRevert(selector);
        router.pay(authorization, new bytes(65));
    }
}
