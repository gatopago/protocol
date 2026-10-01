// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EntryPoint} from "@entrypoint/core/EntryPoint.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Execution} from "src/v3/AccountV3Execution.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {V3SecurityFixture} from "test/helpers/V3SecurityFixture.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";

/// @dev Uses production execution/validation/interop without overrides; only extra observation views.
contract V3ExecutionAccount is AccountV3 {
    constructor(address ep) AccountV3(ep) {}

    function securityState() external view returns (bytes32 manifest, uint256 admin, uint256 reserved, bool frozen) {
        D.Layout storage s = D.layout();
        return (s.manifestHash, s.adminNonce, 0, s.upgradesFrozen);
    }

    function proposal() external view returns (bytes32 hash, uint8 kind) {
        return (D.layout().pending.proposalHash, uint8(D.layout().pending.kind));
    }

    function executing() external view returns (bool) {
        return D.layout().executing;
    }
}

abstract contract V3ExecutionFixture is V3SecurityFixture {
    EntryPoint internal ep;
    V3ExecutionAccount internal implementation;
    AccountFactoryV3 internal factory;
    V3ExecutionAccount internal account;
    T.SecurityPolicy internal policy;
    T.InitializationApproval internal initial;
    address internal recipient;
    address internal bundler;
    address payable internal beneficiary;
    uint48 internal constant START = 1_800_000_000;

    function _setupExecution() internal {
        _setupKeys();
        vm.warp(START);
        vm.fee(1 gwei);
        ep = new EntryPoint();
        implementation = new V3ExecutionAccount(address(ep));
        factory = new AccountFactoryV3(address(implementation), address(ep));
        recipient = makeAddr("execution-recipient");
        bundler = makeAddr("execution-local-bundler");
        beneficiary = payable(makeAddr("execution-gas-beneficiary"));
        policy = _policy(alice, bob);
        initial = _initial(policy, keccak256("execution-account"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
    }

    function _initial(T.SecurityPolicy memory p, bytes32 salt) internal view returns (T.InitializationApproval memory) {
        bytes32 commitment = T.hashPolicy(p);
        return T.InitializationApproval(
            T.accountId(commitment, salt),
            3,
            commitment,
            salt,
            address(factory),
            address(ep),
            keccak256(abi.encode(_chains())),
            0,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 1000)
        );
    }

    function _predicted(T.InitializationApproval memory init) internal view returns (address) {
        return factory.getAddress(init.initialSecurityCommitment, init.userSaltCommitment);
    }

    function _initCode(T.InitializationApproval memory init, T.SecurityPolicy memory p)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = T.digest(block.chainid, _predicted(init), T.hashInitialization(init));
        S.Signature[] memory proofs = new S.Signature[](p.signers.length);
        for (uint256 i; i < proofs.length; ++i) {
            proofs[i] = S.Signature(SafeCast.toUint8(i), _memberSign(p.signers[i], digest));
        }
        return abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (init, p, _chains(), proofs)));
    }

    function _operation(T.InitializationApproval memory init, T.SecurityPolicy memory p, T.Call[] memory calls)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = _predicted(init);
        op.nonce = ep.getNonce(op.sender, 0);
        if (op.sender.code.length == 0) op.initCode = _initCode(init, p);
        uint64 version = op.sender.code.length == 0 ? 1 : V3ExecutionAccount(payable(op.sender)).securityVersion();
        op.callData = calls.length == 0
            ? abi.encodeCall(AccountV3Execution.completeCreation, ())
            : abi.encodeCall(AccountV3Execution.execute, (calls, version));
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | 2_000_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        T.ExecutionPlan memory plan = T.ExecutionPlan(
            init.accountId,
            3,
            version,
            0,
            address(ep),
            ep.getUserOpHash(op),
            calls.length == 0 ? keccak256(op.callData) : keccak256(abi.encode(calls)),
            bytes32(0),
            bytes32(0),
            address(0),
            bytes32(0),
            op.nonce,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 100)
        );
        op.signature = abi.encode(plan, _votes(p, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
    }

    function _direct(T.Call[] memory calls)
        internal
        view
        returns (T.ExecutionPlan memory plan, S.Signature[] memory votes)
    {
        plan = T.ExecutionPlan(
            initial.accountId,
            3,
            account.securityVersion(),
            1,
            address(0),
            bytes32(0),
            keccak256(abi.encode(calls)),
            bytes32(0),
            bytes32(0),
            address(0),
            bytes32(0),
            account.directNonce(),
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 100)
        );
        votes =
            _votes(account.securityPolicy(), T.digest(block.chainid, address(account), T.hashExecution(plan)), P.SPEND);
    }

    function _submit(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, beneficiary);
    }

    function _create() internal {
        vm.deal(address(account), 10 ether);
        _submit(_operation(initial, policy, new T.Call[](0)));
    }

    function _calls(address target, uint256 value, bytes memory data) internal pure returns (T.Call[] memory calls) {
        calls = new T.Call[](1);
        calls[0] = T.Call(target, value, data);
    }

    function _executionChange(T.SecurityPolicy memory next, E.ChangeKind kind)
        internal
        view
        returns (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs)
    {
        (bytes32 manifest, uint256 admin,,) = account.securityState();
        change = T.SecurityChange(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            T.hashPolicy(next),
            keccak256(abi.encode(_chains())),
            admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes),
            SafeCast.toUint48(block.timestamp + 7 days)
        );
        bytes32 structHash = E.hashChange(kind, change);
        digest = T.digest(block.chainid, address(account), structHash);
        // This fixture only rotates to entirely new members. Every one proves its new policy/context.
        proofs = new S.Signature[](next.signers.length);
        for (uint256 i; i < proofs.length; ++i) {
            T.EnrollmentProof memory proof = T.EnrollmentProof(
                initial.accountId,
                3,
                account.securityVersion(),
                T.signerId(next.signers[i]),
                change.nextPolicyHash,
                digest,
                change.nonce,
                change.validAfter,
                change.validUntil
            );
            proofs[i] = S.Signature(
                SafeCast.toUint8(i),
                _memberSign(next.signers[i], T.digest(block.chainid, address(account), T.hashEnrollment(proof)))
            );
        }
    }

    function _executionFreeze() internal view returns (T.FreezeUpgrades memory) {
        (bytes32 manifest, uint256 admin,,) = account.securityState();
        return T.FreezeUpgrades(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            keccak256(abi.encode(_chains())),
            admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 1 days)
        );
    }

    function _executionCommit() internal view returns (T.CommitProposal memory) {
        (bytes32 manifest, uint256 admin,,) = account.securityState();
        (bytes32 proposal,) = account.proposal();
        return T.CommitProposal(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            proposal,
            keccak256("fixture single-chain acknowledgement"),
            keccak256(abi.encode(_chains())),
            admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes)
        );
    }
}
