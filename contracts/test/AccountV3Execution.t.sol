// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {IEntryPoint} from "@entrypoint/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {AccountV3Execution as Execution} from "src/v3/AccountV3Execution.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";

contract V3ExecutionToken is ERC20 {
    constructor(address owner) ERC20("Execution fixture", "TEST") {
        _mint(owner, 1_000_000);
    }
}

contract V3ExecutionCallback {
    bool public nestedSucceeded;
    bytes public nestedError;
    uint256 public received;

    function callback(address target, bytes calldata input) external payable {
        received += msg.value;
        (nestedSucceeded, nestedError) = target.call(input);
    }

    function fail() external pure {
        revert("synthetic target failure");
    }
}

contract AccountV3ExecutionTest is V3ExecutionFixture {
    function setUp() public {
        _setupExecution();
    }

    function test_executionAndFixedLibraryFitEip170() public view {
        assertGt(address(implementation).code.length, 0);
        assertLe(address(implementation).code.length, 24_576);
        assertLe(address(Security).code.length, 24_576);
    }

    function test_counterfactualFirstSpendReservesVerificationSlack() public {
        vm.deal(address(account), 10 ether);
        PackedUserOperation memory op = _operation(initial, policy, _calls(recipient, 1, ""));
        op.accountGasLimits = bytes32((uint256(496_000) << 128) | 2_000_000);
        _resign(op, policy);
        _submit(op);
        assertEq(recipient.balance, 1);
    }

    function test_directDuplicateOrMissingVotesFailThreshold() public {
        policy.spendThreshold = 2;
        initial = _initial(policy, keccak256("threshold-two"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        _create();
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        S.Signature[] memory one = new S.Signature[](1);
        one[0] = votes[0];
        vm.expectRevert(Execution.AccountV3Execution__InvalidSignature.selector);
        account.executeSigned(calls, plan, one);
        votes[1] = votes[0];
        vm.expectRevert(Execution.AccountV3Execution__InvalidSignature.selector);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 0);
        assertEq(account.directNonce(), 0);
    }

    function test_userOpRejectsUnsupportedNonceKeyEvenWhenSigned() public {
        _create();
        PackedUserOperation memory op = _operation(initial, policy, _calls(recipient, 1, ""));
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        op.nonce = uint256(1) << 64;
        plan.nonce = op.nonce;
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, address(account), T.hashExecution(plan)), P.SPEND));
        _expectPlanFailure();
        _submit(op);
    }

    function test_policyRotationAfterValidationInvalidatesOldSpend() public {
        _create();
        T.SecurityPolicy memory next = _policy(carol, dave);
        (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs) =
            _executionChange(next, E.ChangeKind.Security);
        account.prepare(E.ChangeKind.Security, change, next, _chains(), _votes(policy, digest, P.ADMIN), proofs);
        T.CommitProposal memory message = _executionCommit();
        bytes memory input = abi.encodeCall(
            account.commit,
            (message, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(message)), P.ADMIN))
        );
        T.InitializationApproval memory other = _initial(next, keccak256("commit relayer account"));
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _operation(other, next, _calls(address(account), 0, input));
        ops[1] = _operation(initial, policy, _calls(recipient, 1 ether, ""));
        vm.deal(ops[0].sender, 10 ether);
        vm.recordLogs();
        vm.prank(bundler, bundler);
        ep.handleOps(ops, beneficiary);
        assertEq(account.securityVersion(), 2);
        assertEq(recipient.balance, 0);
        assertEq(account.getNonce(), 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertOperationResult(logs, ep.getUserOpHash(ops[0]), true);
        _assertOperationResult(logs, ep.getUserOpHash(ops[1]), false);
        _submit(_operation(initial, next, _calls(recipient, 1 ether, "")));
        assertEq(recipient.balance, 1 ether);
    }

    function testFuzz_counterfactualFirstSpendTransfersAndAccountsForGas(uint96 amount) public {
        uint256 value = bound(amount, 1, 1 ether);
        vm.deal(address(account), 10 ether);
        _submit(_operation(initial, policy, _calls(recipient, value, "")));
        assertEq(recipient.balance, value);
        assertEq(account.getNonce(), 1);
        assertEq(account.directNonce(), 0);
        assertFalse(account.executing());
        assertEq(address(account).balance + ep.balanceOf(address(account)) + beneficiary.balance + value, 10 ether);
        assertGt(beneficiary.balance, 0);
    }

    function test_nativeAndERC20BatchExecutesAsAccount() public {
        _create();
        V3ExecutionToken token = new V3ExecutionToken(address(account));
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(recipient, 2 ether, "");
        calls[1] = T.Call(address(token), 0, abi.encodeCall(token.transfer, (recipient, 123456)));
        _submit(_operation(initial, policy, calls));
        assertEq(recipient.balance, 2 ether);
        assertEq(token.balanceOf(recipient), 123456);
        assertEq(token.balanceOf(address(account)), 876544);
        assertEq(account.getNonce(), 2);
    }

    function test_failedBatchRevertsAssetsButEntryPointConsumesNonceAndGas() public {
        _create();
        V3ExecutionCallback target = new V3ExecutionCallback();
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(recipient, 1 ether, "");
        calls[1] = T.Call(address(target), 0, abi.encodeCall(target.fail, ()));
        uint256 fees = beneficiary.balance;
        _submit(_operation(initial, policy, calls));
        assertEq(recipient.balance, 0);
        assertEq(account.getNonce(), 2);
        assertGt(beneficiary.balance, fees);
        assertFalse(account.executing());
        _submit(_operation(initial, policy, _calls(recipient, 1 ether, "")));
        assertEq(recipient.balance, 1 ether);
    }

    function test_directRelayWorksWithoutEntryPointAndCannotReplay() public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1 ether, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        uint256 epNonce = account.getNonce();
        uint256 epDeposit = ep.balanceOf(address(account));
        vm.prank(carol); // Untrusted payer of transaction gas, not an account owner.
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 1 ether);
        assertEq(account.directNonce(), 1);
        assertEq(account.getNonce(), epNonce);
        assertEq(ep.balanceOf(address(account)), epDeposit);
        vm.expectRevert(Execution.AccountV3Execution__InvalidPlan.selector);
        account.executeSigned(calls, plan, votes);
    }

    function test_directExitCanWithdrawEntryPointDepositWithoutBundler() public {
        _create();
        uint256 deposited = ep.balanceOf(address(account));
        assertGt(deposited, 0);
        T.Call[] memory calls = _calls(address(ep), 0, abi.encodeCall(ep.withdrawTo, (payable(recipient), deposited)));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(ep.balanceOf(address(account)), 0);
        assertEq(recipient.balance, deposited);
    }

    function test_directFailedBatchRollsBackNonceAndAllEffects() public {
        _create();
        V3ExecutionCallback target = new V3ExecutionCallback();
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(recipient, 1 ether, "");
        calls[1] = T.Call(address(target), 0, abi.encodeCall(target.fail, ()));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        vm.expectRevert(abi.encodeWithSelector(Execution.AccountV3Execution__CallFailed.selector, 1, address(target)));
        account.executeSigned(calls, plan, votes);
        assertEq(account.directNonce(), 0);
        assertEq(recipient.balance, 0);
        assertFalse(account.executing());
        calls = _calls(recipient, 1 ether, "");
        (plan, votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(account.directNonce(), 1);
    }

    function testFuzz_directSignedFieldsCannotBeSubstituted(uint8 field) public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1 ether, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        uint8 which = field % 10;
        if (which == 0) plan.executionMode = 0;
        if (which == 1) plan.entryPoint = address(ep);
        if (which == 2) plan.userOpHash = bytes32(uint256(1));
        if (which == 3) plan.paymaster = carol;
        if (which == 4) plan.securityVersion++;
        if (which == 5) plan.nonce++;
        if (which == 6) plan.assetLimitsHash = bytes32(uint256(1));
        if (which == 7) plan.feePolicyHash = bytes32(uint256(1));
        if (which == 8) plan.previewHash = bytes32(uint256(1));
        if (which == 9) calls[0].value++;
        vm.expectRevert(
            which >= 6 && which <= 8
                ? Execution.AccountV3Execution__InvalidSignature.selector
                : Execution.AccountV3Execution__InvalidPlan.selector
        );
        account.executeSigned(calls, plan, votes);
        assertEq(account.directNonce(), 0);
        assertEq(recipient.balance, 0);
    }

    function testFuzz_directWindowIsHalfOpen(uint8 boundary) public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        uint8 which = boundary % 4;
        vm.warp(
            which == 0
                ? plan.validAfter - 1
                : which == 1 ? plan.validAfter : which == 2 ? plan.validUntil - 1 : plan.validUntil
        );
        if (which == 0 || which == 3) vm.expectRevert(Execution.AccountV3Execution__OutsideValidity.selector);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, which == 0 || which == 3 ? 0 : 1);
    }

    function test_directAndUserOpSignaturesCannotCrossModes() public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1, "");
        PackedUserOperation memory op = _operation(initial, policy, calls);
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) =
            abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        vm.expectRevert(Execution.AccountV3Execution__InvalidPlan.selector);
        account.executeSigned(calls, plan, votes);
        (plan, votes) = _direct(calls);
        op.signature = abi.encode(plan, votes);
        _expectPlanFailure();
        _submit(op);
    }

    function testFuzz_wrongUserOpCallGasOrNonceRejected(uint8 field) public {
        vm.deal(address(account), 10 ether);
        PackedUserOperation memory op = _operation(initial, policy, _calls(recipient, 1, ""));
        uint8 which = field % 4;
        if (which == 0) op.callData = abi.encodeCall(Execution.execute, (_calls(carol, 1, ""), uint64(1)));
        if (which == 1) op.preVerificationGas++;
        if (which == 2) op.nonce = uint256(1) << 64;
        if (which == 3) op.callData = bytes.concat(op.callData, hex"00");
        _expectPlanFailure();
        _submit(op);
        assertEq(address(account).code.length, 0);
        assertEq(recipient.balance, 0);
    }

    function test_untrustedOrSelfCallerCannotUseImplicitExecution() public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1, "");
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, alice));
        vm.prank(alice);
        account.execute(calls, 1);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(account)));
        vm.prank(address(account));
        account.execute(calls, 1);
    }

    function testFuzz_directBatchBoundsAndForbiddenTargets(uint8 option) public {
        _create();
        uint8 which = option % 5;
        T.Call[] memory calls = new T.Call[](which == 0 ? 0 : which == 1 ? 33 : which == 2 ? 32 : 1);
        for (uint256 i; i < calls.length; ++i) {
            calls[i] = T.Call(which == 3 ? address(0) : which == 4 ? address(account) : recipient, 1, "");
        }
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        if (which != 2) vm.expectRevert(Execution.AccountV3Execution__InvalidCalls.selector);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, which == 2 ? 32 : 0);
    }

    function test_callbackCannotExecuteAnotherValidSignedBatch() public {
        _create();
        V3ExecutionCallback target = new V3ExecutionCallback();
        T.Call[] memory nested = _calls(recipient, 1 ether, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(nested);
        bytes memory input = abi.encodeCall(account.executeSigned, (nested, plan, votes));
        _submit(
            _operation(
                initial, policy, _calls(address(target), 1, abi.encodeCall(target.callback, (address(account), input)))
            )
        );
        assertFalse(target.nestedSucceeded());
        assertEq(bytes4(target.nestedError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(recipient.balance, 0);
        assertEq(account.directNonce(), 0);
        account.executeSigned(nested, plan, votes); // Callback did not destroy the valid direct authorization.
        assertEq(recipient.balance, 1 ether);
    }

    function test_callbackCannotFreezeEvenWithValidAdminAuthorization() public {
        _create();
        V3ExecutionCallback target = new V3ExecutionCallback();
        T.FreezeUpgrades memory message = _executionFreeze();
        S.Signature[] memory votes =
            _votes(policy, T.digest(block.chainid, address(account), T.hashFreeze(message)), P.ADMIN);
        bytes memory input = abi.encodeCall(account.freeze, (message, _chains(), votes));
        _submit(
            _operation(
                initial, policy, _calls(address(target), 0, abi.encodeCall(target.callback, (address(account), input)))
            )
        );
        assertFalse(target.nestedSucceeded());
        assertEq(bytes4(target.nestedError()), Security.AccountV3Security__Executing.selector);
        (,,, bool frozen) = account.securityState();
        assertFalse(frozen);
        account.freeze(message, _chains(), votes);
        (,,, frozen) = account.securityState();
        assertTrue(frozen);
    }

    function test_retiredSignaturesAndChainReplayFail() public {
        _create();
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(Execution.AccountV3Execution__InvalidSignature.selector);
        account.executeSigned(calls, plan, votes);
        vm.chainId(originalChain);
        T.SecurityPolicy memory next = _policy(carol, dave);
        (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs) =
            _executionChange(next, E.ChangeKind.Security);
        account.prepare(E.ChangeKind.Security, change, next, _chains(), _votes(policy, digest, P.ADMIN), proofs);
        T.CommitProposal memory commit = _executionCommit();
        account.commit(commit, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(commit)), P.ADMIN));
        vm.expectRevert(Execution.AccountV3Execution__InvalidPlan.selector);
        account.executeSigned(calls, plan, votes);
        (plan, votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 1);
    }

    function _resign(PackedUserOperation memory op, T.SecurityPolicy memory p) private view {
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature = abi.encode(plan, _votes(p, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
    }

    function _expectPlanFailure() private {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(Execution.AccountV3Execution__InvalidPlan.selector)
            )
        );
    }

    function _assertOperationResult(Vm.Log[] memory logs, bytes32 opHash, bool expected) private pure {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].topics.length > 1
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
                    && logs[i].topics[1] == opHash
            ) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertEq(success, expected);
                return;
            }
        }
        revert("missing UserOperationEvent");
    }
}

/// @dev Stateful accounting/replay checks on a genuinely initialized proxy and the signed direct path.
contract AccountV3ExecutionInvariantTest is V3ExecutionFixture {
    uint256 internal initialNative;
    uint256 internal authorizedValue;
    uint256 internal successfulNonces;
    bytes internal lastRelay;
    V3ExecutionCallback internal failingTarget;
    bool internal unexpectedSuccess;

    function setUp() public {
        _setupExecution();
        _create();
        initialNative = address(account).balance;
        failingTarget = new V3ExecutionCallback();
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = this.authorizedTransfer.selector;
        selectors[1] = this.replay.selector;
        selectors[2] = this.failBatch.selector;
        selectors[3] = this.unauthorizedTransfer.selector;
        selectors[4] = this.checkApplicationSignature.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector(address(this), selectors));
    }

    function authorizedTransfer(uint96 amount) external {
        uint256 value = bound(amount, 0, address(account).balance);
        T.Call[] memory calls = _calls(recipient, value, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        authorizedValue += value;
        ++successfulNonces;
        lastRelay = abi.encodeCall(account.executeSigned, (calls, plan, votes));
    }

    function replay() external {
        if (lastRelay.length == 0) return;
        (bool success,) = address(account).call(lastRelay);
        unexpectedSuccess = unexpectedSuccess || success;
    }

    function failBatch() external {
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(recipient, address(account).balance / 2, "");
        calls[1] = T.Call(address(failingTarget), 0, abi.encodeCall(failingTarget.fail, ()));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        (bool success,) = address(account).call(abi.encodeCall(account.executeSigned, (calls, plan, votes)));
        unexpectedSuccess = unexpectedSuccess || success;
    }

    function unauthorizedTransfer() external {
        (bool success,) = address(account).call(abi.encodeCall(account.execute, (_calls(recipient, 0, ""), uint64(1))));
        unexpectedSuccess = unexpectedSuccess || success;
    }

    function checkApplicationSignature(bytes32 applicationHash) external {
        T.AccountSignature memory message = T.AccountSignature(initial.accountId, 3, 1, applicationHash);
        bytes memory envelope = abi.encode(
            message, _votes(policy, T.digest(block.chainid, address(account), T.hashAccountSignature(message)), P.SPEND)
        );
        vm.prank(recipient); // An unrelated observer must not consume execution authority.
        assertEq(account.isValidSignature(applicationHash, envelope), bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(applicationHash ^ bytes32(uint256(1)), envelope), bytes4(0xffffffff));
        // The existing stateful nonce/value/security invariants also cover these read-only calls.
    }

    function invariant_valueChangesOnlyByAuthorizedAtomicCalls() public view {
        assertEq(recipient.balance, authorizedValue);
        assertEq(address(account).balance + authorizedValue, initialNative);
        assertFalse(unexpectedSuccess);
    }

    function invariant_nonceCountsSuccessfulDirectBatchesOnly() public view {
        assertEq(account.directNonce(), successfulNonces);
        assertEq(account.getNonce(), 1);
    }

    function invariant_spendCannotChangeSecurityOrLeaveTheLockSet() public view {
        (, uint256 admin, uint256 recovery, bool frozen) = account.securityState();
        assertEq(admin, 0);
        assertEq(recovery, 0);
        assertFalse(frozen);
        assertEq(account.securityVersion(), 1);
        assertFalse(account.executing());
    }
}
