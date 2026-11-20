// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascabelDeposit} from "../../src/deposits/CascabelDeposit.sol";
import {CascabelDepositFactory} from "../../src/deposits/CascabelDepositFactory.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";

contract TestCoin is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns like Circle's TokenMessenger and records what it was asked.
contract TestTokenMessenger is ITokenMessengerV2 {
    bytes public lastCall;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        ERC20(burnToken).transferFrom(msg.sender, address(0xdead), amount);
        lastCall = abi.encode(
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
    }
}

contract CascabelDepositTest is Test {
    uint32 internal constant AVALANCHE = 1;
    uint32 internal constant ARBITRUM = 3;
    /// @dev Circle USDC and the testnet TokenMessenger on Avalanche Fuji, where these tests run.
    address internal constant FUJI_USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    bytes32 internal constant CHARGE = keccak256("pi_1");
    uint256 internal constant CROSSING_FEE = 0.2e6;

    TestCoin internal usdc = TestCoin(FUJI_USDC);
    TestTokenMessenger internal messenger = TestTokenMessenger(TOKEN_MESSENGER);
    TestCoin internal other = new TestCoin();
    CascabelDepositFactory internal factory;
    address internal treasury = makeAddr("treasury");
    address internal localTreasury = makeAddr("localTreasury");

    function setUp() public {
        vm.chainId(43113);
        vm.etch(FUJI_USDC, address(new TestCoin()).code);
        vm.etch(TOKEN_MESSENGER, address(new TestTokenMessenger()).code);
        factory = new CascabelDepositFactory();
    }

    function _settlement(uint32 destinationDomain) internal view returns (CascabelDeposit.Settlement memory) {
        return CascabelDeposit.Settlement({
            recipient: treasury,
            destinationDomain: destinationDomain,
            maxFee: CROSSING_FEE,
            localRecipient: localTreasury
        });
    }

    function test_paysTheTreasuryOnThisNetwork() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(AVALANCHE));
        // The payer only needs the address: the deposit is deployed when it is swept.
        usdc.mint(deposit, 25e6);
        assertEq(deposit.code.length, 0);

        factory.sweep(CHARGE, _settlement(AVALANCHE), usdc);

        assertEq(usdc.balanceOf(treasury), 25e6);
        assertEq(usdc.balanceOf(deposit), 0);
        assertGt(deposit.code.length, 0);
    }

    function test_crossesToTheTreasuryWithCctpPayingTheSettlementFee() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(ARBITRUM));
        usdc.mint(deposit, 25e6);

        // Whoever sweeps, the crossing costs what the settlement fixed.
        vm.prank(makeAddr("stranger"));
        factory.sweep(CHARGE, _settlement(ARBITRUM), usdc);

        assertEq(usdc.balanceOf(deposit), 0);
        assertEq(
            messenger.lastCall(),
            abi.encode(
                uint256(25e6),
                ARBITRUM,
                bytes32(uint256(uint160(treasury))),
                FUJI_USDC,
                bytes32(0),
                CROSSING_FEE,
                uint32(2000),
                hex"636374702d666f72776172640000000000000000000000000000000000000000"
            )
        );
    }

    function test_keepsUsdcTooSmallToCrossOnThisNetwork() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(ARBITRUM));
        usdc.mint(deposit, CROSSING_FEE);

        factory.sweep(CHARGE, _settlement(ARBITRUM), usdc);

        assertEq(usdc.balanceOf(localTreasury), CROSSING_FEE);
        assertEq(messenger.lastCall().length, 0);
    }

    function test_sendsOtherTokensToTheLocalTreasury() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(ARBITRUM));
        other.mint(deposit, 7 ether);

        factory.sweep(CHARGE, _settlement(ARBITRUM), other);

        assertEq(other.balanceOf(localTreasury), 7 ether);
        assertEq(other.balanceOf(treasury), 0);
    }

    function test_sendsTheNativeCoinToTheLocalTreasury() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(ARBITRUM));
        vm.deal(deposit, 1 ether);

        factory.sweepNative(CHARGE, _settlement(ARBITRUM));

        assertEq(localTreasury.balance, 1 ether);
        // A deployed deposit still receives the native coin.
        (bool sent,) = deposit.call{value: 0.5 ether}("");
        assertTrue(sent);
        CascabelDeposit(payable(deposit)).sweepNative();
        assertEq(localTreasury.balance, 1.5 ether);
    }

    function test_anyoneSweepsButOnlyToTheSettlement() public {
        address deposit = factory.depositAddress(CHARGE, _settlement(AVALANCHE));
        usdc.mint(deposit, 10e6);
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        factory.sweep(CHARGE, _settlement(AVALANCHE), usdc);
        usdc.mint(deposit, 5e6);
        vm.prank(stranger);
        CascabelDeposit(payable(deposit)).sweep(usdc);

        assertEq(usdc.balanceOf(treasury), 15e6);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_theAddressCommitsToTheSettlement() public {
        CascabelDeposit.Settlement memory elsewhere = _settlement(AVALANCHE);
        elsewhere.recipient = makeAddr("someoneElse");

        address deposit = factory.depositAddress(CHARGE, _settlement(AVALANCHE));
        assertNotEq(deposit, factory.depositAddress(CHARGE, elsewhere));
        assertNotEq(deposit, factory.depositAddress(keccak256("pi_2"), _settlement(AVALANCHE)));

        factory.deploy(CHARGE, _settlement(AVALANCHE));
        CascabelDeposit.Settlement memory read = CascabelDeposit(payable(deposit)).settlement();
        assertEq(read.recipient, treasury);
        assertEq(read.destinationDomain, AVALANCHE);
        assertEq(read.maxFee, CROSSING_FEE);
        assertEq(read.localRecipient, localTreasury);
        // Deploying again is a no-op that returns the same deposit.
        assertEq(factory.deploy(CHARGE, _settlement(AVALANCHE)), deposit);
    }

    function test_rejectsAnEmptySweep() public {
        vm.expectRevert(CascabelDeposit.CascabelDeposit__Empty.selector);
        factory.sweep(CHARGE, _settlement(AVALANCHE), usdc);
        vm.expectRevert(CascabelDeposit.CascabelDeposit__Empty.selector);
        factory.sweepNative(CHARGE, _settlement(AVALANCHE));
    }

    function test_rejectsASettlementWithoutRecipients() public {
        CascabelDeposit.Settlement memory nobody = _settlement(AVALANCHE);
        nobody.recipient = address(0);
        vm.expectRevert(CascabelDepositFactory.CascabelDepositFactory__InvalidSettlement.selector);
        factory.deploy(CHARGE, nobody);

        nobody = _settlement(AVALANCHE);
        nobody.localRecipient = address(0);
        vm.expectRevert(CascabelDepositFactory.CascabelDepositFactory__InvalidSettlement.selector);
        factory.deploy(CHARGE, nobody);
    }

    function test_settlesEverythingLocallyOnANetworkWithoutConfiguration() public {
        vm.chainId(1);
        CascabelDepositFactory elsewhere = new CascabelDepositFactory();
        address deposit = elsewhere.depositAddress(CHARGE, _settlement(ARBITRUM));
        // Paid on the wrong network, even in a token that is USDC on Fuji: never stuck.
        usdc.mint(deposit, 25e6);

        elsewhere.sweep(CHARGE, _settlement(ARBITRUM), usdc);

        assertEq(usdc.balanceOf(localTreasury), 25e6);
        assertEq(messenger.lastCall().length, 0);
    }

    function test_hasTheSameAddressesOnEveryNetwork() public {
        bytes32 salt = keccak256("cascabel.deposits.v1");
        uint256 fresh = vm.snapshotState();

        vm.chainId(43113);
        CascabelDepositFactory onFuji = new CascabelDepositFactory{salt: salt}();
        address depositOnFuji = onFuji.depositAddress(CHARGE, _settlement(ARBITRUM));
        vm.revertToState(fresh);

        vm.chainId(421614);
        CascabelDepositFactory onArbitrum = new CascabelDepositFactory{salt: salt}();

        assertEq(address(onArbitrum), address(onFuji));
        assertEq(onArbitrum.implementation(), onFuji.implementation());
        assertEq(onArbitrum.depositAddress(CHARGE, _settlement(ARBITRUM)), depositOnFuji);
    }

    function testFuzz_sweepsWhateverArrived(uint96 amount) public {
        vm.assume(amount > 0);
        address deposit = factory.depositAddress(CHARGE, _settlement(AVALANCHE));
        usdc.mint(deposit, amount);
        factory.sweep(CHARGE, _settlement(AVALANCHE), IERC20(address(usdc)));
        assertEq(usdc.balanceOf(treasury), amount);
    }
}
