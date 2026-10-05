// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {MultiSignerERC7913} from "@openzeppelin/contracts/utils/cryptography/signers/MultiSignerERC7913.sol";
import {GatoPagoAccount} from "../../src/wallet/GatoPagoAccount.sol";
import {WalletFixture} from "./WalletFixture.sol";

contract GatoPagoWalletTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE;
    uint256 constant LAPTOP = 0xB0B;
    uint256 constant ARBITRUM_SEPOLIA = 421614;
    uint256 constant AVALANCHE_FUJI = 43113;

    function setUp() public {
        _deployWallet();
    }

    // ── The decisive case ────────────────────────────────────────────────────────────────

    /// Create with the phone → add the laptop → lose the phone → use the laptop on another
    /// network where the account was never deployed, keeping the original address.
    function test_backupKeyRecoversAccountOnNetworkWhereItNeverExisted() public {
        uint256 freshNetwork = vm.snapshotState();
        vm.chainId(ARBITRUM_SEPOLIA);
        bytes[] memory phone = _owners(PHONE);
        address account = factory.getAddress(phone, 0);
        usdc.mint(account, 10e6);
        _send(_signed(_op(account, _initCode(phone), _transfer(merchant, 1e6), 0), PHONE));

        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        bytes memory phoneApproval = _approval(account, PHONE, 0, addLaptop);
        _send(_approvalOp(account, "", 0, addLaptop, phoneApproval));
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));

        // The phone is lost. On Avalanche the account does not exist yet.
        vm.revertToState(freshNetwork);
        vm.chainId(AVALANCHE_FUJI);
        assertEq(account.code.length, 0);
        usdc.mint(account, 10e6);

        PackedUserOperation memory laptopFirst = _signed(_op(account, "", _transfer(merchant, 2e6), 0), LAPTOP);
        _expectFailedOp("AA20 account not deployed");
        _send(laptopFirst);

        // The stored phone approval is replayed: deploys from the original owners, then adds the laptop.
        _send(_approvalOp(account, _initCode(phone), 0, addLaptop, phoneApproval));
        assertEq(factory.getAddress(phone, 0), account);

        _send(_signed(_op(account, "", _transfer(merchant, 2e6), 0), LAPTOP));
        assertEq(usdc.balanceOf(merchant), 2e6);
        assertEq(account.balance, 0);
    }

    /// A griefed attempt (too little call gas) must not burn the approval on that network.
    function test_failedApprovalStaysValidForRetry() public {
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        bytes memory approval = _approval(account, PHONE, 0, addLaptop);

        PackedUserOperation memory starved = _approvalOp(account, "", 0, addLaptop, approval);
        starved.accountGasLimits = bytes32((uint256(2_000_000) << 128) | 30_000);
        starved.paymasterAndData = _sponsored(starved, sponsorKey);
        _send(starved);
        assertFalse(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));
        assertEq(GatoPagoAccount(payable(account)).approvalSequence(), 0);

        _send(_approvalOp(account, "", 0, addLaptop, approval));
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(LAPTOP)[0]));
        assertEq(GatoPagoAccount(payable(account)).approvalSequence(), 1);
    }

    function test_approvalAppliesOnceAndInOrder() public {
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        bytes memory removePhone = abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(PHONE)));
        bytes memory first = _approval(account, PHONE, 0, addLaptop);
        bytes memory second = _approval(account, PHONE, 1, removePhone);

        PackedUserOperation memory early = _approvalOp(account, "", 1, removePhone, second);
        _expectFailedOp("AA24 signature error");
        _send(early);

        _send(_approvalOp(account, "", 0, addLaptop, first));
        PackedUserOperation memory again = _approvalOp(account, "", 0, addLaptop, first);
        _expectFailedOp("AA24 signature error");
        _send(again);

        _send(_approvalOp(account, "", 1, removePhone, second));
        assertFalse(GatoPagoAccount(payable(account)).isSigner(_owners(PHONE)[0]));
    }

    // ── Channel separation ───────────────────────────────────────────────────────────────

    function test_normalChannelCannotChangeOwnersOrUpgrade() public {
        address account = _deployed(PHONE);
        bytes[] memory laptop = _owners(LAPTOP);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (laptop));
        bytes[] memory forbidden = new bytes[](5);
        forbidden[0] = addLaptop;
        forbidden[1] = _batch(account, 0, addLaptop);
        forbidden[2] = _batch(address(0), 0, addLaptop); // ERC-7579 executes address(0) as the account
        forbidden[3] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (address(new GatoPagoAccount()), ""));
        forbidden[4] = abi.encodeCall(GatoPagoAccount.applyApproval, (0, addLaptop));
        for (uint256 i = 0; i < forbidden.length; ++i) {
            PackedUserOperation memory op = _signed(_op(account, "", forbidden[i], 0), PHONE);
            _expectFailedOp("AA24 signature error");
            _send(op);
        }
        assertFalse(GatoPagoAccount(payable(account)).isSigner(laptop[0]));
    }

    function test_replayableChannelCannotMoveFunds() public {
        address account = _deployed(PHONE);
        usdc.mint(account, 10e6);
        bytes memory transfer = _transfer(merchant, 10e6);
        PackedUserOperation memory op = _approvalOp(account, "", 0, transfer, _approval(account, PHONE, 0, transfer));
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    function test_replayableChannelRequiresSponsorship() public {
        address account = _deployed(PHONE);
        vm.deal(account, 1 ether);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        PackedUserOperation memory op = _approvalOp(account, "", 0, addLaptop, _approval(account, PHONE, 0, addLaptop));
        op.paymasterAndData = "";
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    function test_approvalsRejectMalformedCalls() public {
        address account = _deployed(PHONE);
        bytes[] memory malformed = new bytes[](2);
        malformed[0] = hex"abcd"; // shorter than a selector
        malformed[1] = "";
        for (uint256 i = 0; i < malformed.length; ++i) {
            PackedUserOperation memory op =
                _approvalOp(account, "", 0, malformed[i], _approval(account, PHONE, 0, malformed[i]));
            _expectFailedOp("AA24 signature error");
            _send(op);
        }
    }

    function test_approvalChannelOnlyRunsApplyApproval() public {
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        uint192 key = GatoPagoAccount(payable(account)).REPLAYABLE_NONCE_KEY();
        PackedUserOperation memory op = _op(account, "", addLaptop, ep.getNonce(account, key));
        op.signature = _approval(account, PHONE, 0, addLaptop);
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    /// Two approvals with the same sequence in one bundle both pass validation; only one applies.
    function test_approvalOutOfOrderRevertsAtExecution() public {
        address account = _deployed(PHONE);
        bytes memory addLaptop = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(LAPTOP)));
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(GatoPagoAccount.GatoPagoAccountApprovalOutOfOrder.selector, 0, 1));
        GatoPagoAccount(payable(account)).applyApproval(1, addLaptop);
    }

    function test_paymentsOnlyThroughExecute() public {
        address account = _deployed(PHONE);
        bytes[] memory notExecute = new bytes[](2);
        notExecute[0] = hex"abcd";
        notExecute[1] = abi.encodeCall(usdc.transfer, (merchant, 1));
        for (uint256 i = 0; i < notExecute.length; ++i) {
            PackedUserOperation memory op = _signed(_op(account, "", notExecute[i], 0), PHONE);
            _expectFailedOp("AA24 signature error");
            _send(op);
        }
    }

    function test_deploymentAloneNeedsNoCalls() public {
        bytes[] memory owners = _owners(PHONE);
        address account = factory.getAddress(owners, 0);
        _send(_signed(_op(account, _initCode(owners), "", 0), PHONE));
        assertGt(account.code.length, 0);
    }

    // ── Upgrades ─────────────────────────────────────────────────────────────────────────

    function test_upgradeRequiresOwnerApproval() public {
        address account = _deployed(PHONE);
        address next = address(new GatoPagoAccount());

        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        GatoPagoAccount(payable(account)).upgradeToAndCall(next, "");

        bytes memory upgrade = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (next, ""));
        _send(_approvalOp(account, "", 0, upgrade, _approval(account, PHONE, 0, upgrade)));
        assertEq(address(uint160(uint256(vm.load(account, ERC1967Utils.IMPLEMENTATION_SLOT)))), next);
        assertTrue(GatoPagoAccount(payable(account)).isSigner(_owners(PHONE)[0]));
    }

    // ── Basics ───────────────────────────────────────────────────────────────────────────

    function test_passkeyAccountIsCounterfactualAndPaysWithoutEth() public {
        bytes[] memory owners = _owners(PHONE);
        address account = factory.getAddress(owners, 0);
        usdc.mint(account, 100e6);
        assertEq(account.code.length, 0);

        _send(_signed(_op(account, _initCode(owners), _transfer(merchant, 25e6), 0), PHONE));

        assertGt(account.code.length, 0);
        assertEq(usdc.balanceOf(merchant), 25e6);
        assertEq(account.balance, 0);
    }

    function test_unknownPasskeyIsRejected() public {
        address account = _deployed(PHONE);
        PackedUserOperation memory op = _signed(_op(account, "", _transfer(merchant, 1), 0), LAPTOP);
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    function test_paymasterRejectsUnsponsoredOperation() public {
        address account = _deployed(PHONE);
        PackedUserOperation memory op = _op(account, "", _transfer(merchant, 1), 0);
        op.paymasterAndData = _sponsored(op, uint256(keccak256("not the sponsor")));
        op = _signed(op, PHONE);
        _expectFailedOp("AA34 signature error");
        _send(op);
    }

    function test_lastOwnerCannotBeRemoved() public {
        address account = _deployed(PHONE);
        vm.prank(address(ep));
        vm.expectRevert(
            abi.encodeWithSelector(MultiSignerERC7913.MultiSignerERC7913UnreachableThreshold.selector, 0, 1)
        );
        GatoPagoAccount(payable(account)).removeOwners(_owners(PHONE));
    }

    function test_ownersOnlyChangeThroughTheAccount() public {
        address account = _deployed(PHONE);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        GatoPagoAccount(payable(account)).addOwners(_owners(LAPTOP));
        vm.expectRevert();
        GatoPagoAccount(payable(account)).initialize(_owners(LAPTOP));
        GatoPagoAccount implementation = GatoPagoAccount(payable(factory.implementation()));
        vm.expectRevert();
        implementation.initialize(_owners(LAPTOP));
    }

    function test_addressCommitsToOwnersAndSalt() public view {
        assertNotEq(factory.getAddress(_owners(PHONE), 0), factory.getAddress(_owners(LAPTOP), 0));
        assertNotEq(factory.getAddress(_owners(PHONE), 0), factory.getAddress(_owners(PHONE), 1));
    }
}
