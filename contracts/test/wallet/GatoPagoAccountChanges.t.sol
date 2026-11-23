// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {GatoPagoAccount} from "../../src/wallet/GatoPagoAccount.sol";
import {WalletFixture} from "./WalletFixture.sol";

/// Adding owners applies at once; removing owners and upgrading wait two days, and any owner cancels.
contract GatoPagoAccountChangesTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE;
    uint256 constant LAPTOP = 0xB0B;
    address stranger = makeAddr("stranger");

    function setUp() public {
        _deployWallet();
    }

    function test_addingAnOwnerTakesEffectAtOnce() public {
        address account = _withLaptop();
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));
    }

    function test_removingAnOwnerWaitsThenAnyoneAppliesIt() public {
        address account = _withLaptop();
        bytes memory removeLaptop = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(LAPTOP)));
        _send(_approvalOp(account, "", 1, removeLaptop, _approval(account, PHONE, 1, removeLaptop)));
        GatoPagoAccount wallet = GatoPagoAccount(payable(account));
        bytes32 id = wallet.changeId(1, removeLaptop);
        assertEq(wallet.changeReadyAt(id), block.timestamp + 2 days);
        assertTrue(wallet.isSigner(_owners(LAPTOP)[0]));

        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatoPagoAccount.GatoPagoAccountChangeNotReady.selector, id, uint48(block.timestamp + 1)
            )
        );
        wallet.applyChange(1, removeLaptop);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        wallet.applyChange(1, removeLaptop);
        assertFalse(wallet.isSigner(_owners(LAPTOP)[0]));
        vm.expectRevert(abi.encodeWithSelector(GatoPagoAccount.GatoPagoAccountChangeNotScheduled.selector, id));
        wallet.applyChange(1, removeLaptop);
    }

    function test_anUpgradeWaitsToo() public {
        address account = _deployed(PHONE);
        address next = address(new GatoPagoAccount());
        bytes memory upgrade = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (next, ""));
        _send(_approvalOp(account, "", 0, upgrade, _approval(account, PHONE, 0, upgrade)));
        assertEq(_implementation(account), factory.implementation());
        vm.warp(block.timestamp + 2 days);
        GatoPagoAccount(payable(account)).applyChange(0, upgrade);
        assertEq(_implementation(account), next);
    }

    function test_anyOwnerCancelsWithAnOperationForItsNetwork() public {
        address account = _withLaptop();
        bytes memory removePhone = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(PHONE)));
        _send(_approvalOp(account, "", 1, removePhone, _approval(account, LAPTOP, 1, removePhone)));
        GatoPagoAccount wallet = GatoPagoAccount(payable(account));
        bytes32 id = wallet.changeId(1, removePhone);

        _send(_signed(_op(account, "", _cancel(account, id), ep.getNonce(account, 0)), PHONE));
        assertEq(wallet.changeReadyAt(id), 0);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(GatoPagoAccount.GatoPagoAccountChangeNotScheduled.selector, id));
        wallet.applyChange(1, removePhone);
        assertTrue(wallet.isSigner(_owners(PHONE)[0]));
    }

    function test_onlyTheAccountCancels() public {
        address account = _withLaptop();
        bytes memory removeLaptop = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(LAPTOP)));
        _send(_approvalOp(account, "", 1, removeLaptop, _approval(account, PHONE, 1, removeLaptop)));
        bytes32 id = GatoPagoAccount(payable(account)).changeId(1, removeLaptop);
        vm.prank(stranger);
        vm.expectRevert();
        GatoPagoAccount(payable(account)).cancelChange(id);
    }

    function test_anyOwnerAppliesADueChangeWithANormalOperation() public {
        address account = _withLaptop();
        bytes memory removeLaptop = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(LAPTOP)));
        _send(_approvalOp(account, "", 1, removeLaptop, _approval(account, PHONE, 1, removeLaptop)));
        vm.warp(block.timestamp + 2 days);
        bytes memory apply_ = _batch(account, 0, abi.encodeCall(GatoPagoAccount.applyChange, (1, removeLaptop)));
        _send(_signed(_op(account, "", apply_, ep.getNonce(account, 0)), PHONE));
        assertFalse(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));
    }

    function test_paymentsCallTheAccountOnlyToCancelOrApplyChanges() public {
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        bytes[] memory forbidden = new bytes[](3);
        forbidden[0] = _batch(account, 0, addLaptop);
        forbidden[1] = _batch(address(0), 0, addLaptop);
        forbidden[2] = _batch(account, 1, abi.encodeCall(GatoPagoAccount.cancelChange, (bytes32(0))));
        for (uint256 i = 0; i < forbidden.length; ++i) {
            PackedUserOperation memory op = _signed(_op(account, "", forbidden[i], 0), PHONE);
            _expectFailedOp("AA24 signature error");
            _send(op);
        }
        assertFalse(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));
    }

    function test_theLastOwnerStillCannotBeRemoved() public {
        address account = _deployed(PHONE);
        bytes memory removePhone = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(PHONE)));
        _send(_approvalOp(account, "", 0, removePhone, _approval(account, PHONE, 0, removePhone)));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert();
        GatoPagoAccount(payable(account)).applyChange(0, removePhone);
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(PHONE)[0]));
    }

    function _withLaptop() internal returns (address account) {
        account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        _send(_approvalOp(account, "", 0, addLaptop, _approval(account, PHONE, 0, addLaptop)));
    }

    function _cancel(address account, bytes32 id) internal pure returns (bytes memory) {
        return _batch(account, 0, abi.encodeCall(GatoPagoAccount.cancelChange, (id)));
    }

    function _implementation(address account) internal view returns (address) {
        return address(uint160(uint256(vm.load(account, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
