// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {
    ERC7913WebAuthnVerifier
} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";
import {GatoPagoAccount} from "../../src/wallet/GatoPagoAccount.sol";
import {GatoPagoAccountFactory} from "../../src/wallet/GatoPagoAccountFactory.sol";
import {GatoPagoPaymaster} from "../../src/wallet/GatoPagoPaymaster.sol";
import {WalletFixture} from "./WalletFixture.sol";

/// @dev Random sequences of legitimate and illegitimate operations against one account.
contract AccountHandler is WalletFixture {
    GatoPagoAccount public immutable account;
    uint256[] internal ownerKeys;
    uint256 internal nextKey = 0x1000;
    uint256 public appliedApprovals;
    uint256 public spent;
    uint256 public violations;

    constructor(
        IEntryPoint entryPoint,
        ERC7913WebAuthnVerifier webAuthnVerifier,
        GatoPagoAccountFactory accountFactory,
        GatoPagoPaymaster accountPaymaster,
        ERC20Mock token,
        uint256 sponsor,
        uint256 firstOwner
    ) {
        (ep, verifier, factory, paymaster, usdc, sponsorKey) =
        (entryPoint, webAuthnVerifier, accountFactory, accountPaymaster, token, sponsor);
        account = GatoPagoAccount(payable(factory.createAccount(_owners(firstOwner), 0)));
        ownerKeys.push(firstOwner);
        usdc.mint(address(account), 1_000_000e6);
    }

    function owners() external view returns (uint256[] memory) {
        return ownerKeys;
    }

    function addOwner(uint256 signerSeed) external {
        uint256 key = nextKey++;
        if (_applyApproval(signerSeed, abi.encodeCall(GatoPagoAccount.addOwners, (_owners(key))))) {
            ownerKeys.push(key);
        }
    }

    function removeOwner(uint256 signerSeed, uint256 targetSeed) external {
        uint256 index = targetSeed % ownerKeys.length;
        if (_applyApproval(signerSeed, abi.encodeCall(GatoPagoAccount.removeOwners, (_owners(ownerKeys[index]))))) {
            ownerKeys[index] = ownerKeys[ownerKeys.length - 1];
            ownerKeys.pop();
        }
    }

    function spend(uint256 signerSeed, uint256 amount) external {
        amount = bound(amount, 0, usdc.balanceOf(address(account)));
        PackedUserOperation memory op =
            _op(address(account), "", _transfer(merchant, amount), ep.getNonce(address(account), 0));
        if (_trySend(_signed(op, _owner(signerSeed)))) spent += amount;
    }

    /// Must never move funds: the approval channel only accepts owner changes and upgrades.
    function moveFundsWithApproval(uint256 signerSeed) external {
        uint256 balance = usdc.balanceOf(address(account));
        bytes memory call = abi.encodeCall(usdc.transfer, (merchant, balance));
        uint256 sequence = account.approvalSequence();
        _trySend(
            _approvalOp(
                address(account), "", sequence, call, _approval(address(account), _owner(signerSeed), sequence, call)
            )
        );
        if (usdc.balanceOf(address(account)) != balance) violations++;
    }

    /// Must never change owners: the normal channel cannot call the account itself.
    function changeOwnersDirectly(uint256 signerSeed, bool throughZeroAddress) external {
        uint256 key = nextKey++;
        bytes memory add = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(key)));
        bytes memory callData = _batch(throughZeroAddress ? address(0) : address(account), 0, add);
        PackedUserOperation memory op = _op(address(account), "", callData, ep.getNonce(address(account), 0));
        _trySend(_signed(op, _owner(signerSeed)));
        if (account.isSigner(_owners(key)[0])) violations++;
    }

    /// Must never be authorized: a passkey that is not an owner.
    function spendAsStranger(uint256 strangerKey) external {
        strangerKey = bound(strangerKey, 0x100000, 0x1000000);
        uint256 balance = usdc.balanceOf(address(account));
        PackedUserOperation memory op =
            _op(address(account), "", _transfer(merchant, 1), ep.getNonce(address(account), 0));
        _trySend(_signed(op, strangerKey));
        if (usdc.balanceOf(address(account)) != balance) violations++;
    }

    function _applyApproval(uint256 signerSeed, bytes memory call) private returns (bool applied) {
        uint256 sequence = account.approvalSequence();
        bytes memory approval = _approval(address(account), _owner(signerSeed), sequence, call);
        _trySend(_approvalOp(address(account), "", sequence, call, approval));
        applied = account.approvalSequence() == sequence + 1;
        if (applied) appliedApprovals++;
    }

    function _owner(uint256 seed) private view returns (uint256) {
        return ownerKeys[seed % ownerKeys.length];
    }

    function _trySend(PackedUserOperation memory op) private returns (bool) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        try ep.handleOps(ops, payable(bundler)) {
            return true;
        } catch {
            return false;
        }
    }
}

contract GatoPagoAccountInvariantTest is WalletFixture {
    AccountHandler internal handler;
    GatoPagoAccount internal account;
    uint256 internal initialBalance;

    function setUp() public {
        _deployWallet();
        handler = new AccountHandler(ep, verifier, factory, paymaster, usdc, sponsorKey, 0xA11CE);
        account = handler.account();
        initialBalance = usdc.balanceOf(address(account));
        bytes4[] memory actions = new bytes4[](6);
        actions[0] = AccountHandler.addOwner.selector;
        actions[1] = AccountHandler.removeOwner.selector;
        actions[2] = AccountHandler.spend.selector;
        actions[3] = AccountHandler.moveFundsWithApproval.selector;
        actions[4] = AccountHandler.changeOwnersDirectly.selector;
        actions[5] = AccountHandler.spendAsStranger.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: actions}));
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 20
    function invariant_neverLosesItsLastOwner() public view {
        assertGe(account.getSignerCount(), 1);
        assertEq(account.threshold(), 1);
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 20
    function invariant_ownersOnlyChangeThroughApprovals() public view {
        uint256[] memory owners = handler.owners();
        assertEq(account.getSignerCount(), owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            assertTrue(account.isSigner(_ownerOf(owners[i])));
        }
        assertEq(account.approvalSequence(), handler.appliedApprovals());
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 20
    function invariant_fundsOnlyMoveThroughOwnerSpends() public view {
        assertEq(usdc.balanceOf(address(account)), initialBalance - handler.spent());
        assertEq(handler.violations(), 0);
    }

    function _ownerOf(uint256 key) private view returns (bytes memory) {
        return _owners(key)[0];
    }
}

contract GatoPagoAccountFuzzTest is WalletFixture {
    uint256 constant PHONE = 0xA11CE;

    function setUp() public {
        _deployWallet();
    }

    function testFuzz_approvalsAreTheSameOnEveryNetwork(
        uint64 chainA,
        uint64 chainB,
        uint256 sequence,
        bytes calldata call
    ) public {
        GatoPagoAccount account = GatoPagoAccount(payable(_deployed(PHONE)));
        vm.chainId(bound(chainA, 1, type(uint64).max));
        bytes32 onA = account.approvalHash(sequence, call);
        vm.chainId(bound(chainB, 1, type(uint64).max));
        assertEq(account.approvalHash(sequence, call), onA);
    }

    function testFuzz_approvalsOnlyChangeOwnersOrUpgrade(bytes4 selector, bytes calldata arguments) public {
        vm.assume(
            selector != GatoPagoAccount.addOwners.selector && selector != GatoPagoAccount.removeOwners.selector
                && selector != UUPSUpgradeable.upgradeToAndCall.selector
        );
        address account = _deployed(PHONE);
        bytes memory call = abi.encodePacked(selector, arguments);
        PackedUserOperation memory op = _approvalOp(account, "", 0, call, _approval(account, PHONE, 0, call));
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    function testFuzz_paymentsNeverCallTheAccount(uint8 calls, uint8 position, bool throughZeroAddress) public {
        calls = uint8(bound(calls, 1, 5));
        position = uint8(bound(position, 0, calls - 1));
        address account = _deployed(PHONE);
        bytes memory balanceOf = abi.encodeCall(usdc.balanceOf, (account));
        bytes memory forbidden = abi.encodeCall(GatoPagoAccount.addOwners, (_owners(0xB0B)));

        Execution[] memory batch = new Execution[](calls);
        for (uint256 i = 0; i < calls; ++i) {
            batch[i] = i == position
                ? Execution(throughZeroAddress ? address(0) : account, 0, forbidden)
                : Execution(address(usdc), 0, balanceOf);
        }
        bytes memory callData = _batch(batch);
        PackedUserOperation memory op = _signed(_op(account, "", callData, 0), PHONE);
        _expectFailedOp("AA24 signature error");
        _send(op);
    }

    function testFuzz_addressCommitsToOwnersAndSalt(uint256 keyA, uint256 keyB, uint256 salt) public {
        keyA = bound(keyA, 1, P256_N - 1);
        keyB = bound(keyB, 1, P256_N - 1);
        vm.assume(keyA != keyB);
        address predicted = factory.getAddress(_owners(keyA), salt);
        assertNotEq(predicted, factory.getAddress(_owners(keyB), salt));
        assertEq(factory.createAccount(_owners(keyA), salt), predicted);
        assertTrue(GatoPagoAccount(payable(predicted)).isSigner(_owners(keyA)[0]));
    }
}
