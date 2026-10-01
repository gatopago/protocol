// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Execution as Execution} from "src/v3/AccountV3Execution.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "@entrypoint/interfaces/IEntryPoint.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint as OZEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {GatoPagoPaymaster} from "src/GatoPagoPaymaster.sol";
import {GatoPagoPaymentRouter} from "src/GatoPagoPaymentRouter.sol";
import {GatoPagoCrosschainRouter} from "src/GatoPagoCrosschainRouter.sol";
import {GatoPagoCctpPaymentRouter} from "src/GatoPagoCctpPaymentRouter.sol";
import {MockTokenMessengerV2} from "test/GatoPagoCrosschainRouter.t.sol";
import {V3Deployment} from "script/DeployV3.s.sol";

contract V3ConsumerToken is ERC20 {
    constructor(address recipient) ERC20("Local USDC fixture", "USDC") {
        _mint(recipient, 100e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev Exact production account, real EntryPoint and real software P256 verification.
/// Public mathematical WebAuthn vector, NOT a hardware/browser ceremony or bundler admission.
contract AccountV3ConsumerProfileTest is V3ExecutionFixture {
    function setUp() public {
        _setupExecution();
        // Use fixture helpers, but deploy the production implementation without observation subclasses.
        V3Deployment.Stack memory stack = V3Deployment.deploy(address(ep));
        implementation = V3ExecutionAccount(payable(address(stack.implementation)));
        factory = stack.factory;
        AccountV3WebAuthnVerifier verifier = stack.verifier;
        (uint256 x, uint256 y) = vm.publicKeyP256(1);
        policy.mode = P.ACTIVE;
        policy.adminThreshold = 1;
        delete policy.signers;
        policy.signers
            .push(
                T.SignerDescriptor(
                    P.WEBAUTHN,
                    address(verifier),
                    address(verifier).codehash,
                    abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), x, y),
                    P.SPEND | P.ADMIN
                )
            );
        initial = _initial(policy, keccak256("consumer-profile-software-p256"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        vm.deal(address(account), 10 ether);
        // Do not mock a successful P256 signature. Empty native response forces OZ software fallback.
        vm.mockCall(address(0x100), bytes(""), bytes(""));
    }

    function test_singlePasskeyCreatesAndSendsWithoutActivationSoftwareP256() public {
        PackedUserOperation memory creation = _budget(_operation(initial, policy, new T.Call[](0)));
        assertLe(abi.encode(creation).length, 8192, "Consumer creation exceeds packed UserOperation limit");
        emit log_named_uint("creation packed operation bytes (ABI)", abi.encode(creation).length);
        uint256 beforeGas = gasleft();
        _submit(creation);
        emit log_named_uint("creation handleOps gas (local warm test context)", beforeGas - gasleft());
        assertEq(account.getNonce(), 1);

        V3ConsumerToken token = new V3ConsumerToken(address(account));
        PackedUserOperation memory send = _budget(
            _operation(initial, policy, _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 100e6))))
        );
        assertLe(abi.encode(send).length, 8192, "Consumer send exceeds packed UserOperation limit");
        emit log_named_uint("send packed operation bytes (ABI)", abi.encode(send).length);
        beforeGas = gasleft();
        _submit(send);
        emit log_named_uint("send handleOps gas (local warm test context)", beforeGas - gasleft());
        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(account.getNonce(), 2);
    }

    function test_sponsoredCreationProviderReplacementAndSelfFundedFallback() public {
        // Public test-only sponsor scalar; never an operational key.
        GatoPagoPaymaster sponsor = _paymaster();
        vm.deal(address(account), 0);
        uint256 depositBefore = sponsor.getDeposit();
        _submit(_sponsor(_budget(_operation(initial, policy, new T.Call[](0))), sponsor));
        assertEq(account.getNonce(), 1);
        assertEq(address(account).balance, 0);
        assertLt(sponsor.getDeposit(), depositBefore);

        V3ConsumerToken token = new V3ConsumerToken(address(account));
        GatoPagoPaymaster replacement = _paymaster();
        sponsor.setSponsorSigner(makeAddr("retired-provider"));
        T.Call[] memory calls = _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 50e6)));
        PackedUserOperation memory send = _sponsor(_budget(_operation(initial, policy, calls)), replacement);
        _submit(send);
        assertEq(token.balanceOf(recipient), 50e6);
        assertEq(address(account).balance, 0);

        replacement.setSponsorSigner(makeAddr("provider-offline"));
        vm.deal(address(account), 1 ether);
        _submit(_budget(_operation(initial, policy, calls)));
        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(token.balanceOf(address(account)), 0);
        assertLt(address(account).balance, 1 ether);
    }

    function test_accountBatchPaysCheckoutOnceAndRollsBackFailedReplay() public {
        _submit(_budget(_operation(initial, policy, new T.Call[](0))));
        V3ConsumerToken token = new V3ConsumerToken(address(account));
        GatoPagoPaymentRouter router = new GatoPagoPaymentRouter(
            address(this), IERC20(address(token)), address(this), vm.addr(0xB0B), address(this)
        );
        GatoPagoPaymentRouter.PaymentAuthorization memory auth = GatoPagoPaymentRouter.PaymentAuthorization(
            keccak256("intent"),
            keccak256("attempt"),
            address(account),
            recipient,
            50e6,
            0,
            START,
            START + 600,
            bytes32(0)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, router.authorizationDigest(auth));
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(address(token), 0, abi.encodeCall(token.approve, (address(router), 50e6)));
        calls[1] = T.Call(address(router), 0, abi.encodeCall(router.pay, (auth, abi.encodePacked(r, s, v))));
        _submit(_budget(_operation(initial, policy, calls)));
        assertTrue(router.paidIntent(auth.intentId));
        assertEq(token.balanceOf(recipient), 50e6);
        assertEq(token.allowance(address(account), address(router)), 0);
        // EntryPoint includes a failed execution; the account batch rolls back its approval.
        _submit(_budget(_operation(initial, policy, calls)));
        assertEq(token.balanceOf(recipient), 50e6);
        assertEq(token.balanceOf(address(account)), 50e6);
        assertEq(token.allowance(address(account), address(router)), 0);
        assertEq(account.getNonce(), 3);
    }

    function test_accountBatchOutboundBurnLeavesNoRouterFundsOrAllowance() public {
        _submit(_budget(_operation(initial, policy, new T.Call[](0))));
        V3ConsumerToken token = new V3ConsumerToken(address(account));
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2();
        uint32[] memory domains = new uint32[](1);
        domains[0] = 6;
        GatoPagoCrosschainRouter router =
            new GatoPagoCrosschainRouter(address(this), IERC20(address(token)), messenger, address(this), domains);
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(address(token), 0, abi.encodeCall(token.approve, (address(router), 100e6)));
        calls[1] = T.Call(
            address(router),
            0,
            abi.encodeCall(
                router.bridgeUSDC,
                (keccak256("outbound"), 100e6, 0, uint32(6), bytes32(uint256(uint160(recipient))), 0, uint32(2000))
            )
        );
        _submit(_budget(_operation(initial, policy, calls)));
        assertEq(messenger.lastAmount(), 100e6);
        assertEq(messenger.lastDestinationCaller(), bytes32(0));
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.allowance(address(router), address(messenger)), 0);
    }

    function test_accountBatchCctpCheckoutBurnIsNotDestinationSettlement() public {
        _submit(_budget(_operation(initial, policy, new T.Call[](0))));
        V3ConsumerToken token = new V3ConsumerToken(address(account));
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2();
        GatoPagoCctpPaymentRouter router = new GatoPagoCctpPaymentRouter(
            address(this),
            IERC20(address(token)),
            messenger,
            address(this),
            vm.addr(0xB0B),
            address(this),
            421614,
            false,
            100
        );
        GatoPagoCctpPaymentRouter.CctpPaymentAuthorization memory auth =
            GatoPagoCctpPaymentRouter.CctpPaymentAuthorization(
                keccak256("cctp-intent"),
                keccak256("cctp-attempt"),
                address(account),
                recipient,
                421614,
                3,
                100e6,
                100e6,
                0,
                0,
                2000,
                START,
                START + 600,
                bytes32(0)
            );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, router.authorizationDigest(auth));
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(address(token), 0, abi.encodeCall(token.approve, (address(router), 100e6)));
        calls[1] = T.Call(address(router), 0, abi.encodeCall(router.pay, (auth, abi.encodePacked(r, s, v))));
        _submit(_budget(_operation(initial, policy, calls)));
        assertTrue(router.paidIntent(auth.intentId));
        assertEq(messenger.lastAmount(), 100e6);
        assertEq(messenger.lastMintRecipient(), bytes32(uint256(uint160(recipient))));
        assertEq(token.balanceOf(recipient), 0, "source burn does not prove destination settlement");
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.allowance(address(router), address(messenger)), 0);
    }

    function _paymaster() private returns (GatoPagoPaymaster sponsor) {
        sponsor = new GatoPagoPaymaster(OZEntryPoint(address(ep)), address(this));
        sponsor.setSponsorSigner(vm.addr(0xB0B));
        sponsor.setMaxSponsoredGasCost(0.1 ether);
        vm.deal(address(this), 10 ether);
        sponsor.deposit{value: 1 ether}();
    }

    function _sponsor(PackedUserOperation memory op, GatoPagoPaymaster sponsor)
        private
        view
        returns (PackedUserOperation memory)
    {
        bytes memory header = abi.encodePacked(address(sponsor), uint128(150_000), uint128(0));
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                address(sponsor),
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(header),
                uint256(START - 1),
                uint256(START + 600)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, MessageHashUtils.toEthSignedMessageHash(digest));
        op.paymasterAndData = abi.encodePacked(header, uint48(START - 1), uint48(START + 600), r, s, v);
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.paymaster = address(sponsor);
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
        return op;
    }

    /// @dev Expected failure is a release blocker, not permission to raise a public bundler's limit.
    function test_softwareP256CreationIsNotAdmittedAt496kBudget() public {
        PackedUserOperation memory op = _operation(initial, policy, new T.Call[](0));
        op.accountGasLimits = bytes32((uint256(496_000) << 128) | 2_000_000);
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA13 initCode failed or OOG"));
        _submit(op);
        assertEq(address(account).code.length, 0);
        assertEq(address(account).balance, 10 ether);
        assertEq(ep.getNonce(address(account), 0), 0);
    }

    function _budget(PackedUserOperation memory op) private view returns (PackedUserOperation memory) {
        // Measurement ceiling only. This is deliberately NOT a supported public bundler gas profile.
        op.accountGasLimits = bytes32((uint256(4_000_000) << 128) | 2_000_000);
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
        return op;
    }

    function test_optionalBackupAloneCanRetireLostKeyAndExitWithoutGatoPago() public {
        _submit(_budget(_operation(initial, policy, new T.Call[](0))));
        T.SecurityPolicy memory two = account.securityPolicy();
        T.SignerDescriptor memory backup = _backup();
        two.signers = new T.SignerDescriptor[](2);
        two.signers[0] = policy.signers[0];
        two.signers[1] = backup;
        _sort(two);
        uint8 oldIndex = T.signerId(two.signers[0]) == T.signerId(policy.signers[0]) ? 0 : 1;
        uint8 backupIndex = 1 - oldIndex;
        (T.SecurityChange memory change, bytes32 digest) = _consumerChange(two);
        S.Signature[] memory proofs = _backupProof(change, digest, backupIndex, backup);
        S.Signature[] memory owner = _one(0, 1, digest);
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.prepare(E.ChangeKind.Security, change, two, _chains(), owner, new S.Signature[](0));
        // Possession of the prospective key alone is NOT authority from the current policy.
        S.Signature[] memory prospective = _one(0, 2, digest);
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.prepare(E.ChangeKind.Security, change, two, _chains(), prospective, proofs);
        account.prepare(E.ChangeKind.Security, change, two, _chains(), owner, proofs);
        _consumerCommit(0, 1);
        assertEq(account.securityVersion(), 2);
        assertEq(account.securityPolicy().adminThreshold, 1);

        // Backup alone authorizes removal of A; no support, email or old device needed.
        T.SecurityPolicy memory onlyBackup = account.securityPolicy();
        onlyBackup.signers = new T.SignerDescriptor[](1);
        onlyBackup.signers[0] = backup;
        (change, digest) = _consumerChange(onlyBackup);
        account.prepare(
            E.ChangeKind.Security, change, onlyBackup, _chains(), _one(backupIndex, 2, digest), new S.Signature[](0)
        );
        _consumerCommit(backupIndex, 2);
        assertEq(account.securityVersion(), 3);
        assertEq(account.securityPolicy().signers.length, 1);
        assertEq(T.signerId(account.securityPolicy().signers[0]), T.signerId(backup));

        V3ConsumerToken token = new V3ConsumerToken(address(account));
        T.Call[] memory calls = _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 100e6)));
        (T.ExecutionPlan memory plan,) = _direct(calls);
        bytes32 sendDigest = T.digest(block.chainid, address(account), T.hashExecution(plan));
        // A no longer controls the account, even with a fresh correctly scoped signature.
        S.Signature[] memory retired = _one(0, 1, sendDigest);
        vm.expectRevert(Execution.AccountV3Execution__InvalidSignature.selector);
        account.executeSigned(calls, plan, retired);
        account.executeSigned(calls, plan, _one(0, 2, sendDigest));
        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(token.balanceOf(address(account)), 0);
    }

    function test_cannotRemoveLastKeyOrInstallUnreachableAuthority() public {
        _submit(_budget(_operation(initial, policy, new T.Call[](0))));
        T.SecurityPolicy memory invalid = account.securityPolicy();
        invalid.signers = new T.SignerDescriptor[](0);
        (T.SecurityChange memory change, bytes32 digest) = _consumerChange(invalid);
        S.Signature[] memory auth = _one(0, 1, digest);
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        account.prepare(E.ChangeKind.Security, change, invalid, _chains(), auth, new S.Signature[](0));
        invalid = account.securityPolicy();
        invalid.adminThreshold = 0;
        (change, digest) = _consumerChange(invalid);
        auth = _one(0, 1, digest);
        vm.expectRevert(P.AccountV3Policy__InvalidThreshold.selector);
        account.prepare(E.ChangeKind.Security, change, invalid, _chains(), auth, new S.Signature[](0));
        invalid.adminThreshold = 2;
        (change, digest) = _consumerChange(invalid);
        auth = _one(0, 1, digest);
        vm.expectRevert(P.AccountV3Policy__InvalidThreshold.selector);
        account.prepare(E.ChangeKind.Security, change, invalid, _chains(), auth, new S.Signature[](0));
        assertEq(account.securityVersion(), 1);
        assertEq(account.securitySnapshot()[7], 0);
    }

    function _backup() private view returns (T.SignerDescriptor memory member) {
        member = policy.signers[0];
        (uint256 x, uint256 y) = vm.publicKeyP256(2);
        member.key = abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), x, y);
    }

    function _consumerChange(T.SecurityPolicy memory next)
        private
        view
        returns (T.SecurityChange memory change, bytes32 digest)
    {
        uint256[16] memory state = account.securitySnapshot();
        change = T.SecurityChange(
            initial.accountId,
            3,
            account.securityVersion(),
            bytes32(state[2]),
            T.hashPolicy(next),
            keccak256(abi.encode(_chains())),
            state[7],
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes),
            SafeCast.toUint48(block.timestamp + 1 days)
        );
        digest = T.digest(block.chainid, address(account), T.hashSecurity(change));
    }

    function _backupProof(T.SecurityChange memory change, bytes32 digest, uint8 index, T.SignerDescriptor memory member)
        private
        view
        returns (S.Signature[] memory)
    {
        T.EnrollmentProof memory proof = T.EnrollmentProof(
            initial.accountId,
            3,
            change.securityVersion,
            T.signerId(member),
            change.nextPolicyHash,
            digest,
            change.nonce,
            change.validAfter,
            change.validUntil
        );
        return _one(index, 2, T.digest(block.chainid, address(account), T.hashEnrollment(proof)));
    }

    function _consumerCommit(uint8 index, uint256 scalar) private {
        uint256[16] memory state = account.securitySnapshot();
        T.CommitProposal memory message = T.CommitProposal(
            initial.accountId,
            3,
            account.securityVersion(),
            bytes32(state[2]),
            bytes32(state[10]),
            keccak256("local-only checkpoint"),
            bytes32(state[13]),
            state[7],
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes)
        );
        account.commit(message, _one(index, scalar, T.digest(block.chainid, address(account), T.hashCommit(message))));
    }

    function _one(uint8 index, uint256 scalar, bytes32 digest) private pure returns (S.Signature[] memory votes) {
        bytes memory data = abi.encodePacked(sha256("gatopago.com"), bytes1(0x05), bytes4(0));
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://gatopago.com","crossOrigin":false}'
        );
        // Public scalar 1/2 mathematical test fixtures, never user credentials.
        (bytes32 r, bytes32 s) = vm.signP256(scalar, sha256(abi.encodePacked(data, sha256(bytes(json)))));
        if (uint256(s) > P256.N / 2) s = bytes32(P256.N - uint256(s));
        votes = new S.Signature[](1);
        votes[0] = S.Signature(index, abi.encode(r, s, uint256(23), uint256(1), data, json));
    }
}
