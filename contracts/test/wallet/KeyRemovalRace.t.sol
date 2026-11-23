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

/// KupiaSec's finding (email of 19-10-2026, medium), on the real EntryPoint v0.9: owner changes are
/// signed without the chain id, apply on every network in sequence order, one passkey is enough, and
/// the approval channel needs a paymaster but not ours. With a stolen passkey the thief, through its
/// own paymaster and transactions, used to lock the owner out of any network where the owner's
/// removal of it had not landed. Now removals wait two days, and the owner cancels the thief's.
contract KeyRemovalRaceTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE; // the owner's passkey, the account's first
    uint256 constant LAPTOP = 0xB0B; // the backup, stolen
    uint256 constant ARBITRUM_SEPOLIA = 421614;
    uint256 constant AVALANCHE_FUJI = 43113;

    address thief = makeAddr("thief");
    AnyonePaymaster thiefPaymaster;

    function setUp() public {
        _deployWallet();
        thiefPaymaster = new AnyonePaymaster();
        ep.depositTo{value: 1 ether}(address(thiefPaymaster));
    }

    /// The thief signs its own next approval, removing the owner, and lands it first: it is only
    /// scheduled, and the owner cancels it.
    function test_theThiefCannotLockTheOwnerOut() public {
        address account = _deployed(PHONE);
        _send(_approvalOp(account, "", 0, _addLaptop(), _approval(account, PHONE, 0, _addLaptop())));

        _thiefSends(
            _paidByThief(_approvalOp(account, "", 1, _removePhone(), _approval(account, LAPTOP, 1, _removePhone())))
        );
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(PHONE)[0]));
        _cancelled(account);
    }

    /// Where the account never existed, the thief replays the owner's approval that added the
    /// stolen key, then its own: that one waits too.
    function test_aNewNetworkGivesTheThiefNoShortcut() public {
        uint256 freshNetwork = vm.snapshotState();
        vm.chainId(ARBITRUM_SEPOLIA);
        address account = _deployed(PHONE);
        bytes memory added = _approval(account, PHONE, 0, _addLaptop());

        vm.revertToState(freshNetwork);
        vm.chainId(AVALANCHE_FUJI);
        assertEq(account.code.length, 0);
        _thiefSends(_paidByThief(_approvalOp(account, _initCode(_owners(PHONE)), 0, _addLaptop(), added)));
        _thiefSends(
            _paidByThief(_approvalOp(account, "", 1, _removePhone(), _approval(account, LAPTOP, 1, _removePhone())))
        );
        _cancelled(account);
    }

    /// What the wait cannot close: where nothing was deployed yet, the account starts with its
    /// first owners only. If the stolen passkey is the first, the thief takes approval #0 there and
    /// the owner's backup, approved as #0 elsewhere, never gets in. The app applies every approval
    /// on every network as soon as it is signed, deploying the account where it is missing.
    function test_theFirstPasskeyStillOwnsNetworksWhereNothingWasDeployed() public {
        uint256 freshNetwork = vm.snapshotState();
        vm.chainId(ARBITRUM_SEPOLIA);
        address account = _deployed(PHONE);
        // The thief holds PHONE: its own approval #0 is as valid as the owner's.
        bytes memory addThief = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(0xBAD)));
        bytes memory signed = _approval(account, PHONE, 0, addThief);

        vm.revertToState(freshNetwork);
        vm.chainId(AVALANCHE_FUJI);
        _thiefSends(_paidByThief(_approvalOp(account, _initCode(_owners(PHONE)), 0, addThief, signed)));
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(0xBAD)[0]));
    }

    function _addLaptop() internal view returns (bytes memory) {
        return abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
    }

    function _removePhone() internal view returns (bytes memory) {
        return abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(PHONE)));
    }

    /// The owner cancels approval #1 with a normal operation for this network; once due, it cannot
    /// be applied.
    function _cancelled(address account) internal {
        GatoPagoAccount wallet = GatoPagoAccount(payable(account));
        bytes32 id = wallet.changeId(1, _removePhone());
        assertGt(wallet.changeReadyAt(id), 0);
        bytes memory cancel = _batch(account, 0, abi.encodeCall(GatoPagoAccount.cancelChange, (id)));
        _send(_signed(_op(account, "", cancel, ep.getNonce(account, 0)), PHONE));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(GatoPagoAccount.GatoPagoAccountChangeNotScheduled.selector, id));
        wallet.applyChange(1, _removePhone());
        assertTrue(wallet.isSigner(_owners(PHONE)[0]));
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
}
