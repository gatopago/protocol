// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GatoPagoPaymaster} from "../../src/wallet/GatoPagoPaymaster.sol";
import {WalletFixture} from "./WalletFixture.sol";

contract GatoPagoPaymasterTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE;
    address stranger = makeAddr("stranger");

    function setUp() public {
        _deployWallet();
    }

    function test_onlyTheOwnerManagesFunds() public {
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeCall(paymaster.setSponsorSigner, (stranger));
        calls[1] = abi.encodeCall(paymaster.withdraw, (payable(stranger), 1));
        calls[2] = abi.encodeCall(paymaster.addStake, (1 days));
        calls[3] = abi.encodeCall(paymaster.unlockStake, ());
        calls[4] = abi.encodeCall(paymaster.withdrawStake, (payable(stranger)));
        calls[5] = abi.encodeCall(paymaster.setRelayer, (stranger));
        for (uint256 i = 0; i < calls.length; ++i) {
            vm.prank(stranger);
            (bool success, bytes memory reason) = address(paymaster).call(calls[i]);
            assertFalse(success);
            assertEq(reason, abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        }
    }

    function test_ownerWithdrawsTheDeposit() public {
        uint256 deposit = ep.balanceOf(address(paymaster));
        paymaster.withdraw(payable(stranger), 1 ether);
        assertEq(ep.balanceOf(address(paymaster)), deposit - 1 ether);
        assertEq(stranger.balance, 1 ether);
    }

    function test_anyoneCanTopUpTheDeposit() public {
        uint256 deposit = ep.balanceOf(address(paymaster));
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        paymaster.deposit{value: 1 ether}();
        assertEq(ep.balanceOf(address(paymaster)), deposit + 1 ether);
    }

    function test_stakeLifecycle() public {
        paymaster.addStake{value: 1 ether}(1 days);
        paymaster.unlockStake();
        vm.warp(block.timestamp + 1 days);
        paymaster.withdrawStake(payable(stranger));
        assertEq(stranger.balance, 1 ether);
    }

    function test_rotatingTheSponsorSignerRevokesTheOldOne() public {
        address account = _deployed(PHONE);
        usdc.mint(account, 2e6);
        PackedUserOperation memory signedByOldSponsor = _signed(_op(account, "", _transfer(merchant, 1e6), 0), PHONE);

        (address newSponsor, uint256 newSponsorKey) = makeAddrAndKey("new sponsor");
        paymaster.setSponsorSigner(newSponsor);
        _expectFailedOp("AA34 signature error");
        _send(signedByOldSponsor);

        sponsorKey = newSponsorKey;
        _send(_signed(_op(account, "", _transfer(merchant, 1e6), 0), PHONE));
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_onlyTheRelayerIncludesASponsoredOperation() public {
        address account = _deployed(PHONE);
        usdc.mint(account, 1e6);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _signed(_op(account, "", _transfer(merchant, 1e6), 0), PHONE);

        // Anyone else sending the sponsored operation would be paid from the deposit: refused.
        _expectFailedOp("AA34 signature error");
        vm.prank(stranger, stranger);
        ep.handleOps(ops, payable(stranger));

        _send(ops[0]);
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_rotatingTheRelayer() public {
        address account = _deployed(PHONE);
        PackedUserOperation memory op = _signed(_op(account, "", _transfer(merchant, 0), 0), PHONE);
        address newRelayer = makeAddr("new relayer");
        vm.expectEmit(address(paymaster));
        emit GatoPagoPaymaster.RelayerUpdated(newRelayer);
        paymaster.setRelayer(newRelayer);

        _expectFailedOp("AA34 signature error");
        _send(op);

        vm.expectRevert(GatoPagoPaymaster.GatoPagoPaymaster__InvalidRelayer.selector);
        paymaster.setRelayer(address(0));
    }

    function test_expiredSponsorshipIsRejected() public {
        address account = _deployed(PHONE);
        PackedUserOperation memory op = _signed(_op(account, "", _transfer(merchant, 0), 0), PHONE);
        vm.warp(block.timestamp + 301);
        _expectFailedOp("AA32 paymaster expired or not due");
        _send(op);
    }
}
