// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Account as OZAccount, PackedUserOperation as OZUserOp} from "@openzeppelin/contracts/account/Account.sol";
import {EntryPoint} from "@entrypoint/core/EntryPoint.sol";
import {IEntryPoint} from "@entrypoint/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";
import {AccountV3Execution} from "src/v3/AccountV3Execution.sol";
import {V3SecurityFixture} from "test/helpers/V3SecurityFixture.sol";
import {V3EntryPointValidationHarness as Probe, V3EntryPointActionProbe} from "test/helpers/V3EntryPointFixture.sol";

/// @dev Real EntryPoint, factory, signatures, prefund and nonce accounting; only the action is a probe.
/// All keys/balances are ephemeral Forge fixtures. No RPC, paymaster, bundler or deployed account is used.
contract AccountV3EntryPointTest is V3SecurityFixture {
    EntryPoint internal ep;
    Probe internal implementation;
    AccountFactoryV3 internal factory;
    address internal bundler;
    address payable internal beneficiary;
    uint48 internal constant START = 1_800_000_000;

    function setUp() public {
        _setupKeys();
        vm.warp(START);
        vm.fee(1 gwei);
        ep = new EntryPoint();
        implementation = new Probe(address(ep));
        factory = new AccountFactoryV3(address(implementation), address(ep));
        bundler = makeAddr("synthetic-local-bundler");
        beneficiary = payable(makeAddr("synthetic-gas-beneficiary"));
    }

    function test_handleOpsCreatesValidatesExecutesAndChargesCounterfactualPrefund() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        assertGt(op.sender.code.length, 0);
        Probe account = Probe(payable(op.sender));
        assertEq(account.acknowledgements(), 1);
        assertEq(account.creationWindow(), 0);
        assertEq(account.getNonce(), 1);
        assertGt(beneficiary.balance, 0);
        assertEq(op.sender.balance + ep.balanceOf(op.sender) + beneficiary.balance, 1 ether);
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) = account.creationIdentity();
        assertEq(generation, 3);
        assertEq(id, initial.accountId);
        assertEq(commitment, initial.initialSecurityCommitment);
        assertEq(salt, initial.userSaltCommitment);
    }

    function testFuzz_creationWindowIsHalfOpenAtAllFourBoundaries(uint32 offset, uint8 boundary) public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        initial.validAfter = START + SafeCast.toUint48(bound(offset, 10, 1_000_000));
        initial.validUntil = initial.validAfter + 60;
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, initial.validUntil + 100, false);
        vm.deal(op.sender, 1 ether);
        uint8 which = boundary % 4;
        uint48 now_ = which == 0
            ? initial.validAfter - 1
            : which == 1 ? initial.validAfter : which == 2 ? initial.validUntil - 1 : initial.validUntil;
        vm.warp(now_);
        if (which == 0 || which == 3) {
            vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
            _submit(op);
            _assertUncreated(op.sender);
        } else {
            _submit(op);
            assertEq(Probe(payable(op.sender)).acknowledgements(), 1);
        }
    }

    function testFuzz_operationWindowCannotBeWidenedByCreationWindow(uint8 boundary) public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START + 10, START + 20, false);
        vm.deal(op.sender, 1 ether);
        uint8 which = boundary % 4;
        vm.warp(which == 0 ? START + 9 : which == 1 ? START + 10 : which == 2 ? START + 19 : START + 20);
        if (which == 0 || which == 3) {
            vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
            _submit(op);
            _assertUncreated(op.sender);
        } else {
            _submit(op);
            assertEq(Probe(payable(op.sender)).acknowledgements(), 1);
        }
    }

    function test_invalidPossessionRevertsWholeCreation() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        S.Signature[] memory proofs = _possession(initial, policy);
        proofs[0].signature = hex"deadbeef";
        bytes memory code = abi.encodePacked(
            address(factory), abi.encodeCall(factory.createAccount, (initial, policy, _chains(), proofs))
        );
        PackedUserOperation memory op = _operation(initial, policy, code, 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA13 initCode failed or OOG"));
        _submit(op);
        _assertUncreated(op.sender);
    }

    /// @dev Documents a release blocker: deployed-account recovery cannot rescue an uncreated address.
    function test_prefundedExpiredCreationCannotRenewWithLostInitialSigner() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        S.Signature[] memory oldProofs = _possession(initial, policy);
        bytes memory oldCode = _initCode(initial, policy);
        vm.warp(initial.validUntil + 1);
        uint48 now_ = SafeCast.toUint48(block.timestamp);
        // A fresh spend signature cannot extend the old creation authorization.
        PackedUserOperation memory op = _operation(initial, policy, oldCode, 0, now_, now_ + 100, false);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        _submit(op);
        _assertUncreated(op.sender);

        initial.validAfter = now_;
        initial.validUntil = now_ + 1000;
        S.Signature[] memory proofs = _possession(initial, policy);
        // Model loss: the missing key cannot renew its proof; only its old signature is available.
        proofs[0] = oldProofs[0];
        bytes memory renewed = abi.encodePacked(
            address(factory), abi.encodeCall(factory.createAccount, (initial, policy, _chains(), proofs))
        );
        op = _operation(initial, policy, renewed, 0, now_, now_ + 100, false);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA13 initCode failed or OOG"));
        _submit(op);
        _assertUncreated(op.sender);
        // Replacing the lost member changes the identity/address; it does not recover the funded one.
        T.SecurityPolicy memory replacement = _policy(alice, carol);
        assertNotEq(factory.getAddress(T.hashPolicy(replacement), initial.userSaltCommitment), op.sender);
    }

    function test_invalidUserOpSignatureRevertsWholeCreation() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) =
            abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        votes[0].signature = hex"deadbeef";
        op.signature = abi.encode(plan, votes);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _submit(op);
        _assertUncreated(op.sender);
    }

    function test_signedGasCannotBeReplacedByBundler() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        op.preVerificationGas += 1;
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(AccountV3Execution.AccountV3Execution__InvalidPlan.selector)
            )
        );
        _submit(op);
        _assertUncreated(op.sender);
    }

    function test_executionRevertPreservesCreationAndConsumesNonce() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, true);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        Probe account = Probe(payable(op.sender));
        assertGt(op.sender.code.length, 0);
        assertEq(account.acknowledgements(), 0);
        assertEq(account.creationWindow(), 0);
        assertEq(account.getNonce(), 1);
        assertGt(beneficiary.balance, 0);
        vm.warp(initial.validUntil + 1);
        _submit(_operation(initial, policy, "", 1, initial.validUntil, initial.validUntil + 100, false));
        assertEq(account.acknowledgements(), 1);
        assertEq(account.getNonce(), 2);
    }

    function test_staleInitCodeOnExistingAccountDoesNotReapplyCreationWindow() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        bytes memory code = _initCode(initial, policy);
        PackedUserOperation memory op = _operation(initial, policy, code, 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        vm.warp(initial.validUntil + 1);
        _submit(_operation(initial, policy, code, 1, initial.validUntil, initial.validUntil + 100, false));
        assertEq(Probe(payable(op.sender)).acknowledgements(), 2);
        assertEq(Probe(payable(op.sender)).creationWindow(), 0);
    }

    function test_replayRejectedByRealEntryPointNonce() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        uint256 balanceBefore = op.sender.balance;
        uint256 depositBefore = ep.balanceOf(op.sender);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce"));
        _submit(op);
        assertEq(Probe(payable(op.sender)).acknowledgements(), 1);
        assertEq(op.sender.balance, balanceBefore);
        assertEq(ep.balanceOf(op.sender), depositBefore);
    }

    function test_twoUserOpsValidateBeforeExecutionWithoutReinitializing() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        ops[1] = _operation(initial, policy, "", 1, START, START + 100, false);
        vm.deal(ops[0].sender, 1 ether);
        vm.prank(bundler, bundler);
        ep.handleOps(ops, beneficiary);
        assertEq(Probe(payable(ops[0].sender)).acknowledgements(), 2);
        assertEq(Probe(payable(ops[0].sender)).getNonce(), 2);
    }

    function test_unvalidatedCreationRemainsPendingAndCannotChangeSecurity() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        S.Signature[] memory proofs = _possession(initial, policy);
        uint256[] memory chains = _chains();
        // Isolate a creation that has not been followed by validation. This caller impersonation
        // is a fault-injection fixture, NOT an assertion that real SenderCreator allows this path.
        vm.prank(address(ep.senderCreator()));
        Probe account = Probe(payable(factory.createAccount(initial, policy, chains, proofs)));
        uint256 pending = account.creationWindow();
        assertGt(pending, 0);
        vm.expectRevert(Security.AccountV3Security__CreationPending.selector);
        account.expire(bytes32(0));
        vm.warp(initial.validUntil + 1);
        PackedUserOperation memory op =
            _operation(initial, policy, "", 0, initial.validUntil, initial.validUntil + 100, false);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA22 expired or not due"));
        _submit(op);
        assertEq(account.creationWindow(), pending);
        assertEq(account.getNonce(), 0);
        assertEq(op.sender.balance, 1 ether);
    }

    function test_nonEntryPointCannotValidateOrExecute() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        Probe account = Probe(payable(op.sender));
        OZUserOp memory ozOp = abi.decode(abi.encode(op), (OZUserOp));
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        account.validateUserOp(ozOp, bytes32(0), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        account.execute(new T.Call[](0), 1);
        assertEq(account.acknowledgements(), 1);
    }

    function testFuzz_invalidInitializationWindowNeverDeploys(uint8 variant) public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        if (variant % 3 == 0) initial.validAfter = 0;
        else if (variant % 3 == 1) initial.validUntil = initial.validAfter;
        else initial.validUntil = 0x800000000000;
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA13 initCode failed or OOG"));
        _submit(op);
        _assertUncreated(op.sender);
    }

    function testFuzz_invalidOperationWindowNeverActivates(uint8 variant) public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        uint48 after_ = variant % 3 == 0 ? 0 : START;
        uint48 until_ = variant % 3 == 1 ? START : variant % 3 == 2 ? 0x800000000000 : START + 100;
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, after_, until_, false);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPoint.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(Validity.AccountV3Validity__InvalidWindow.selector)
            )
        );
        _submit(op);
        _assertUncreated(op.sender);
    }

    function test_invalidSecondOperationRollsBackTheWholeBundle() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        ops[1] = _operation(initial, policy, "", 2, START, START + 100, false);
        vm.deal(ops[0].sender, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 1, "AA25 invalid account nonce"));
        vm.prank(bundler, bundler);
        ep.handleOps(ops, beneficiary);
        _assertUncreated(ops[0].sender);
    }

    function test_creationFitsCanonicalVerificationGasBudget() public {
        _creationWithBudget(500_000);
    }

    function test_creationReservesCanonicalEstimationSlack() public {
        // ERC-7562 requires 4,000 gas slack on top of the estimate. Preserve that
        // space under the 500,000 cap without using an alternative prefunding path.
        _creationWithBudget(496_000);
    }

    function _creationWithBudget(uint256 budget) internal {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        op.accountGasLimits = bytes32((budget << 128) | 100_000);
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
        assertLe(abi.encode(op).length, 8192);
        vm.deal(op.sender, 1 ether);
        _submit(op);
        assertEq(Probe(payable(op.sender)).acknowledgements(), 1);
    }

    function test_validationTraceHasNoClockBalanceOrEntryPointCodeReads() public {
        (T.InitializationApproval memory initial, T.SecurityPolicy memory policy) = _initial();
        PackedUserOperation memory op =
            _operation(initial, policy, _initCode(initial, policy), 0, START, START + 100, false);
        vm.deal(op.sender, 1 ether);
        vm.startDebugTraceRecording();
        _submit(op);
        Vm.DebugStep[] memory steps = vm.stopAndReturnDebugTraceRecording();
        uint256 factorySteps;
        uint256 accountSteps;
        uint256 securitySteps;
        uint256 securityWrites;
        uint256 securityCalls;
        uint64 securityDepth;
        uint256 entryPointClockReads;
        uint256 create2Count;
        for (uint256 i; i < steps.length; ++i) {
            Vm.DebugStep memory step = steps[i];
            if (step.contractAddr == address(ep) && step.opcode == 0x42) ++entryPointClockReads;
            bool isFactory = step.contractAddr == address(factory);
            bool isAccount = step.contractAddr == address(implementation) || step.contractAddr == op.sender;
            // DebugStep.contractAddr is the storage context: DELEGATECALL instructions
            // still belong to the proxy, not the library's code address. Track the
            // observed fixed-target call/depth instead of silently excluding its body.
            if (securityDepth != 0 && step.depth < securityDepth) securityDepth = 0;
            if (!isFactory && !isAccount) continue;
            if (isFactory) ++factorySteps;
            if (isAccount) ++accountSteps;
            if (securityDepth != 0 && step.depth >= securityDepth) {
                ++securitySteps;
                if (step.opcode == 0x55) ++securityWrites;
            }
            if (isAccount && step.opcode == 0xf4 && address(uint160(step.stack[1])) == address(Security)) {
                ++securityCalls;
                securityDepth = step.depth + 1;
            }
            if (step.opcode == 0xf5) ++create2Count;
            assertFalse(step.opcode == 0x42 || step.opcode == 0x43, "Clock read inside factory/account frame");
            assertFalse(step.opcode == 0x31 || step.opcode == 0x47, "Balance read inside factory/account frame");
            if (step.opcode == 0x3b || step.opcode == 0x3c || step.opcode == 0x3f) {
                assertNotEq(address(uint160(step.stack[0])), address(ep), "EntryPoint EXTCODE access during validation");
            }
        }
        assertGt(factorySteps, 0, "Trace did not observe factory");
        assertGt(accountSteps, 0, "Trace did not observe account");
        assertGt(securitySteps, 0, "Trace did not observe linked initialization");
        assertGt(securityWrites, 0, "Trace did not observe policy installation in proxy storage");
        // Library view functions still use DELEGATECALL to read the account's storage.
        // The two calls are initialization and the production execution-signature predicate;
        // external cryptographic validators (not the linked library) use STATICCALL.
        assertEq(securityCalls, 2, "Expected initialization and production signature predicate");
        assertGt(entryPointClockReads, 0, "Trace did not observe real EntryPoint time check");
        assertEq(create2Count, 1);
    }

    function _initial()
        internal
        view
        returns (T.InitializationApproval memory initial, T.SecurityPolicy memory policy)
    {
        policy = _policy(alice, bob);
        bytes32 commitment = T.hashPolicy(policy);
        bytes32 salt = keccak256("local-entrypoint-integration");
        initial = T.InitializationApproval(
            T.accountId(commitment, salt),
            3,
            commitment,
            salt,
            address(factory),
            address(ep),
            keccak256(abi.encode(_chains())),
            0,
            START,
            START + 1000
        );
    }

    function _possession(T.InitializationApproval memory initial, T.SecurityPolicy memory policy)
        internal
        view
        returns (S.Signature[] memory proofs)
    {
        address predicted = factory.getAddress(initial.initialSecurityCommitment, initial.userSaltCommitment);
        bytes32 digest = T.digest(block.chainid, predicted, T.hashInitialization(initial));
        proofs = new S.Signature[](policy.signers.length);
        for (uint256 i; i < proofs.length; ++i) {
            proofs[i] = S.Signature(SafeCast.toUint8(i), _memberSign(policy.signers[i], digest));
        }
    }

    function _initCode(T.InitializationApproval memory initial, T.SecurityPolicy memory policy)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            address(factory),
            abi.encodeCall(factory.createAccount, (initial, policy, _chains(), _possession(initial, policy)))
        );
    }

    function _operation(
        T.InitializationApproval memory initial,
        T.SecurityPolicy memory policy,
        bytes memory initCode,
        uint256 nonce,
        uint48 after_,
        uint48 until_,
        bool shouldFail
    ) internal view returns (PackedUserOperation memory op) {
        op.sender = factory.getAddress(initial.initialSecurityCommitment, initial.userSaltCommitment);
        op.nonce = nonce;
        op.initCode = initCode;
        T.Call[] memory calls = new T.Call[](1);
        calls[0] = T.Call(
            address(implementation.actionProbe()), 0, abi.encodeCall(V3EntryPointActionProbe.acknowledge, (shouldFail))
        );
        op.callData = abi.encodeCall(AccountV3Execution.execute, (calls, 1));
        // Generous local probe budget is NOT proof of ERC-7562 MAX_VERIFICATION_GAS admission.
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | 100_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        T.ExecutionPlan memory plan = T.ExecutionPlan(
            initial.accountId,
            3,
            1,
            0,
            address(ep),
            ep.getUserOpHash(op),
            keccak256(abi.encode(calls)),
            bytes32(0),
            bytes32(0),
            address(0),
            bytes32(0),
            nonce,
            after_,
            until_
        );
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
    }

    function _submit(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, beneficiary);
    }

    function _assertUncreated(address sender) internal view {
        assertEq(sender.code.length, 0);
        assertEq(sender.balance, 1 ether);
        assertEq(ep.balanceOf(sender), 0);
        assertEq(ep.getNonce(sender, 0), 0);
        assertEq(beneficiary.balance, 0);
    }
}
