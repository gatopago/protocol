// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {GatoPagoPaymentRouter} from "../src/GatoPagoPaymentRouter.sol";
import {GatoPagoCctpPaymentRouter} from "../src/GatoPagoCctpPaymentRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";

contract InvariantCheckoutUSDC is ERC20 {
    constructor() ERC20("Invariant Checkout USDC", "USDC") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract InvariantTokenMessengerV2 is ITokenMessengerV2 {
    using SafeERC20 for IERC20;

    uint256 public totalBurned;
    uint256 public callCount;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256,
        uint32 minFinalityThreshold
    ) external {
        require(destinationDomain == 3, "destination domain");
        require(mintRecipient != bytes32(0), "mint recipient");
        require(destinationCaller == bytes32(0), "destination caller");
        require(minFinalityThreshold == 1000 || minFinalityThreshold == 2000, "finality");
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);
        totalBurned += amount;
        ++callCount;
    }
}

contract LocalPaymentHandler is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant MAX_SETTLEMENT = 1_000_000e6;

    InvariantCheckoutUSDC public immutable usdc;
    GatoPagoPaymentRouter public immutable router;
    address public immutable payer;
    address public immutable merchant;
    address public immutable treasury;

    uint256 public ghostSettlement;
    uint256 public ghostPlatformFees;
    uint256 public ghostPaymentCount;

    constructor(
        InvariantCheckoutUSDC token,
        GatoPagoPaymentRouter paymentRouter,
        address payerAddress,
        address merchantAddress,
        address treasuryAddress
    ) {
        usdc = token;
        router = paymentRouter;
        payer = payerAddress;
        merchant = merchantAddress;
        treasury = treasuryAddress;
    }

    function pay(uint96 rawSettlement, uint16 rawFeeBps) external {
        uint256 settlement = bound(uint256(rawSettlement), 1, MAX_SETTLEMENT);
        uint256 feeBps = bound(uint256(rawFeeBps), 0, router.MAX_PLATFORM_FEE_BPS());
        uint256 platformFee = settlement * feeBps / 10_000;
        uint256 sequence = ghostPaymentCount + 1;

        GatoPagoPaymentRouter.PaymentAuthorization memory authorization = GatoPagoPaymentRouter.PaymentAuthorization({
            intentId: keccak256(abi.encode("local-intent", sequence)),
            attemptId: keccak256(abi.encode("local-attempt", sequence)),
            payer: payer,
            merchant: merchant,
            settlementAmount: settlement,
            platformFee: platformFee,
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 1 hours),
            metadataHash: keccak256(abi.encode("local-metadata", sequence))
        });

        bytes32 digest = router.authorizationDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);

        vm.prank(payer);
        router.pay(authorization, abi.encodePacked(r, s, v));

        ghostSettlement += settlement;
        ghostPlatformFees += platformFee;
        ghostPaymentCount = sequence;
    }
}

contract CctpPaymentHandler is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant MAX_SETTLEMENT = 1_000_000e6;

    InvariantCheckoutUSDC public immutable usdc;
    GatoPagoCctpPaymentRouter public immutable router;
    address public immutable payer;
    address public immutable merchant;
    address public immutable treasury;

    uint256 public ghostBurned;
    uint256 public ghostPlatformFees;
    uint256 public ghostPaymentCount;

    constructor(
        InvariantCheckoutUSDC token,
        GatoPagoCctpPaymentRouter paymentRouter,
        address payerAddress,
        address merchantAddress,
        address treasuryAddress
    ) {
        usdc = token;
        router = paymentRouter;
        payer = payerAddress;
        merchant = merchantAddress;
        treasury = treasuryAddress;
    }

    function pay(uint96 rawSettlement, uint16 rawFeeBps, uint24 rawCctpFee, bool fast) external {
        uint256 settlement = bound(uint256(rawSettlement), 1, MAX_SETTLEMENT);
        uint256 feeBps = bound(uint256(rawFeeBps), 0, router.MAX_PLATFORM_FEE_BPS());
        uint256 platformFee = settlement * feeBps / 10_000;
        uint256 maxCctpFee = bound(uint256(rawCctpFee), 0, settlement / 100);
        uint256 burnAmount = settlement + maxCctpFee;
        uint256 grossPayerAmount = burnAmount + platformFee;
        uint256 sequence = ghostPaymentCount + 1;

        GatoPagoCctpPaymentRouter.CctpPaymentAuthorization memory authorization =
            GatoPagoCctpPaymentRouter.CctpPaymentAuthorization({
                intentId: keccak256(abi.encode("cctp-intent", sequence)),
                attemptId: keccak256(abi.encode("cctp-attempt", sequence)),
                payer: payer,
                merchant: merchant,
                settlementChainId: router.SETTLEMENT_CHAIN_ID(),
                destinationDomain: router.ARBITRUM_DOMAIN(),
                settlementAmount: settlement,
                grossPayerAmount: grossPayerAmount,
                platformFee: platformFee,
                maxCctpFee: maxCctpFee,
                minFinalityThreshold: fast ? router.FAST_FINALITY() : router.STANDARD_FINALITY(),
                validAfter: uint48(block.timestamp),
                validUntil: uint48(block.timestamp + 1 hours),
                metadataHash: keccak256(abi.encode("cctp-metadata", sequence))
            });

        bytes32 digest = router.authorizationDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);

        vm.prank(payer);
        router.pay(authorization, abi.encodePacked(r, s, v));

        ghostBurned += burnAmount;
        ghostPlatformFees += platformFee;
        ghostPaymentCount = sequence;
    }
}

contract GatoPagoPaymentRouterInvariantTest is StdInvariant, Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant INITIAL_BALANCE = 1_000_000_000_000e6;

    InvariantCheckoutUSDC internal usdc;
    GatoPagoPaymentRouter internal router;
    LocalPaymentHandler internal handler;
    address internal payer;
    address internal merchant;
    address internal treasury;

    function setUp() public {
        payer = makeAddr("local invariant payer");
        merchant = makeAddr("local invariant merchant");
        treasury = makeAddr("local invariant treasury");
        usdc = new InvariantCheckoutUSDC();
        router = new GatoPagoPaymentRouter(
            makeAddr("local invariant owner"),
            IERC20(address(usdc)),
            treasury,
            vm.addr(SIGNER_KEY),
            makeAddr("local invariant pause guardian")
        );
        handler = new LocalPaymentHandler(usdc, router, payer, merchant, treasury);
        usdc.mint(payer, INITIAL_BALANCE);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
        targetContract(address(handler));
    }

    function invariant_routerNeverCustodiesUsdc() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function invariant_localAccountingIsConserved() public view {
        assertEq(usdc.balanceOf(merchant), handler.ghostSettlement());
        assertEq(usdc.balanceOf(treasury), handler.ghostPlatformFees());
        assertEq(usdc.balanceOf(payer) + handler.ghostSettlement() + handler.ghostPlatformFees(), INITIAL_BALANCE);
    }
}

contract GatoPagoCctpPaymentRouterInvariantTest is StdInvariant, Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant INITIAL_BALANCE = 1_000_000_000_000e6;

    InvariantCheckoutUSDC internal usdc;
    InvariantTokenMessengerV2 internal messenger;
    GatoPagoCctpPaymentRouter internal router;
    CctpPaymentHandler internal handler;
    address internal payer;
    address internal treasury;

    function setUp() public {
        payer = makeAddr("cctp invariant payer");
        treasury = makeAddr("cctp invariant treasury");
        usdc = new InvariantCheckoutUSDC();
        messenger = new InvariantTokenMessengerV2();
        router = new GatoPagoCctpPaymentRouter(
            makeAddr("cctp invariant owner"),
            IERC20(address(usdc)),
            messenger,
            treasury,
            vm.addr(SIGNER_KEY),
            makeAddr("cctp invariant pause guardian"),
            421614,
            true,
            100
        );
        handler = new CctpPaymentHandler(usdc, router, payer, makeAddr("cctp invariant merchant"), treasury);
        usdc.mint(payer, INITIAL_BALANCE);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
        targetContract(address(handler));
    }

    function invariant_routerNeverCustodiesUsdc() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function invariant_cctpAccountingIsConserved() public view {
        assertEq(usdc.balanceOf(address(messenger)), handler.ghostBurned());
        assertEq(messenger.totalBurned(), handler.ghostBurned());
        assertEq(usdc.balanceOf(treasury), handler.ghostPlatformFees());
        assertEq(usdc.balanceOf(payer) + handler.ghostBurned() + handler.ghostPlatformFees(), INITIAL_BALANCE);
        assertEq(messenger.callCount(), handler.ghostPaymentCount());
    }
}
