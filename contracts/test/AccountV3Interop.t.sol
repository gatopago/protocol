// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAccount} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Execution as Execution} from "src/v3/AccountV3Execution.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";

/// @dev Ordinary application: it knows ERC-1271, not GatoPago's envelope internals.
contract V3SignatureApp is EIP712 {
    mapping(address => uint256) public nonces;
    bool public callbackAccepted;

    constructor() EIP712("Local signature consumer", "1") {}

    function orderHash(address owner, address recipient, uint256 amount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256("Order(address owner,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"),
                    owner,
                    recipient,
                    amount,
                    nonce,
                    deadline
                )
            )
        );
    }

    function consume(
        address owner,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        // Synthetic clock selects a test validity boundary, not randomness or production finality.
        // forge-lint: disable-next-line(block-timestamp)
        require(nonces[owner] == nonce && block.timestamp < deadline, "application nonce/deadline");
        require(
            SignatureChecker.isValidSignatureNow(owner, orderHash(owner, recipient, amount, nonce, deadline), sig),
            "signature"
        );
        ++nonces[owner];
    }

    function check(address owner, bytes32 hash, bytes calldata sig) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(owner, hash, sig);
    }

    function callback(bytes32 hash, bytes calldata sig) external {
        callbackAccepted = SignatureChecker.isValidSignatureNow(msg.sender, hash, sig);
        require(callbackAccepted, "callback signature");
    }
}

contract V3InteropNFT is ERC721 {
    constructor(address owner) ERC721("Local receiver test", "TEST") {
        _safeMint(owner, 1);
    }
}

contract V3InteropMultiToken is ERC1155 {
    constructor(address owner) ERC1155("") {
        _mint(owner, 1, 10, "");
        uint256[] memory ids = new uint256[](2);
        uint256[] memory values = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        values[0] = 20;
        values[1] = 30;
        _mintBatch(owner, ids, values, "");
    }
}

contract AccountV3InteropTest is V3ExecutionFixture {
    V3SignatureApp internal app;
    bytes4 internal constant VALID = IERC1271.isValidSignature.selector;
    bytes4 internal constant INVALID = 0xffffffff;

    function setUp() public {
        _setupExecution();
        app = new V3SignatureApp();
    }

    function _message(bytes32 hash) internal view returns (T.AccountSignature memory) {
        return T.AccountSignature(initial.accountId, 3, account.securityVersion(), hash);
    }

    function _signature(bytes32 hash) internal view returns (bytes memory) {
        T.AccountSignature memory message = _message(hash);
        return abi.encode(
            message,
            _votes(
                account.securityPolicy(),
                T.digest(block.chainid, address(account), T.hashAccountSignature(message)),
                P.SPEND
            )
        );
    }

    function testFuzz_validSignatureIsReadOnlyRepeatableAndNotCallerRestricted(bytes32 hash) public {
        _create();
        bytes memory sig = _signature(hash);
        uint256 epNonce = account.getNonce();
        vm.record();
        vm.recordLogs();
        assertEq(account.isValidSignature(hash, sig), VALID);
        (, bytes32[] memory writes) = vm.accesses(address(account));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(app.check(address(account), hash, sig));
        vm.prank(recipient);
        assertEq(account.isValidSignature(hash, sig), VALID);
        assertEq(account.directNonce(), 0);
        assertEq(account.getNonce(), epNonce);
    }

    function test_applicationEnforcesItsOwnDomainNonceDeadlineAndOrderFields() public {
        _create();
        uint256 deadline = block.timestamp + 100;
        bytes32 hash = app.orderHash(address(account), recipient, 123, 0, deadline);
        bytes memory sig = _signature(hash);
        V3SignatureApp other = new V3SignatureApp();
        assertFalse(other.check(address(account), other.orderHash(address(account), recipient, 123, 0, deadline), sig));
        assertFalse(app.check(address(account), app.orderHash(address(account), alice, 123, 0, deadline), sig));
        app.consume(address(account), recipient, 123, 0, deadline, sig);
        vm.expectRevert("application nonce/deadline");
        app.consume(address(account), recipient, 123, 0, deadline, sig);
        vm.warp(deadline);
        assertEq(account.isValidSignature(hash, sig), VALID, "wallet does not consume the application's nonce");
        vm.expectRevert("application nonce/deadline");
        app.consume(address(account), recipient, 123, 1, deadline, sig);
    }

    function testFuzz_accountSignatureCannotChangeItsSignedFields(uint8 variant) public {
        _create();
        bytes32 hash = keccak256("application");
        (T.AccountSignature memory message, S.Signature[] memory votes) =
            abi.decode(_signature(hash), (T.AccountSignature, S.Signature[]));
        variant = uint8(bound(variant, 0, 5));
        if (variant == 0) message.accountId = bytes32(uint256(message.accountId) ^ 1);
        if (variant == 1) message.generation = 2;
        if (variant == 2) ++message.securityVersion;
        if (variant == 3) message.applicationHash = keccak256("substitution");
        if (variant == 4) hash = keccak256("substitution");
        if (variant == 5) vm.chainId(block.chainid + 1);
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
    }

    function test_sharedOwnersDoNotAllowReplayToAnotherAccount() public {
        _create();
        bytes32 hash = keccak256("same application digest");
        bytes memory sig = _signature(hash);
        T.InitializationApproval memory otherInitial = _initial(policy, keccak256("other account"));
        address other = _predicted(otherInitial);
        vm.deal(other, 10 ether);
        _submit(_operation(otherInitial, policy, new T.Call[](0)));
        assertFalse(app.check(other, hash, sig));
        (T.AccountSignature memory message, S.Signature[] memory votes) =
            abi.decode(sig, (T.AccountSignature, S.Signature[]));
        message.accountId = otherInitial.accountId;
        assertFalse(app.check(other, hash, abi.encode(message, votes)), "address/domain remains signed");
    }

    function test_rawOwnerSpendAndAdminSignaturesCannotCrossPurposes() public {
        _create();
        bytes32 hash = keccak256("application");
        T.AccountSignature memory message = _message(hash);
        assertFalse(app.check(address(account), hash, abi.encode(message, _votes(policy, hash, P.SPEND))));
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory spend) = _direct(calls);
        message.applicationHash = T.digest(block.chainid, address(account), T.hashExecution(plan));
        assertFalse(app.check(address(account), message.applicationHash, abi.encode(message, spend)));
        (, S.Signature[] memory votes) =
            abi.decode(_signature(message.applicationHash), (T.AccountSignature, S.Signature[]));
        vm.expectRevert(Execution.AccountV3Execution__InvalidSignature.selector);
        account.executeSigned(calls, plan, votes);
        T.FreezeUpgrades memory freeze = _executionFreeze();
        bytes32 freezeDigest = T.digest(block.chainid, address(account), T.hashFreeze(freeze));
        (, votes) = abi.decode(_signature(freezeDigest), (T.AccountSignature, S.Signature[]));
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.freeze(freeze, _chains(), votes);
    }

    function test_missingDuplicateOrNonSpendVotesCannotSatisfyQuorum() public {
        policy.spendThreshold = 2;
        initial = _initial(policy, keccak256("two spend factors"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        _create();
        bytes32 hash = keccak256("application");
        bytes memory sig = _signature(hash);
        assertTrue(app.check(address(account), hash, sig));
        (T.AccountSignature memory message, S.Signature[] memory votes) =
            abi.decode(sig, (T.AccountSignature, S.Signature[]));
        S.Signature[] memory one = new S.Signature[](1);
        one[0] = votes[0];
        assertFalse(app.check(address(account), hash, abi.encode(message, one)));
        votes[1] = votes[0];
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
        votes[1].signerIndex = 16;
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
    }

    function test_adminRecoveryOnlyKeyCannotSignForAnApplication() public {
        policy.signers[0].roles = P.ADMIN;
        initial = _initial(policy, keccak256("role separated"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        _create();
        bytes32 hash = keccak256("application");
        T.AccountSignature memory message = _message(hash);
        S.Signature[] memory votes = new S.Signature[](1);
        votes[0] = S.Signature(
            0,
            _memberSign(policy.signers[0], T.digest(block.chainid, address(account), T.hashAccountSignature(message)))
        );
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
        assertTrue(app.check(address(account), hash, _signature(hash)));
    }

    function testFuzz_malformedSignaturesFailClosedThroughStandardConsumer(bytes memory garbage) public {
        _create();
        assertFalse(app.check(address(account), keccak256("unsigned application"), garbage));
    }

    function test_encodingBoundsPaddingAndTruncationFailClosed() public {
        _create();
        bytes32 hash = keccak256("application");
        bytes memory sig = _signature(hash);
        assertFalse(app.check(address(account), hash, bytes.concat(sig, hex"00")));
        assertFalse(app.check(address(account), hash, new bytes(67_777)));
        (T.AccountSignature memory message, S.Signature[] memory votes) =
            abi.decode(sig, (T.AccountSignature, S.Signature[]));
        votes[0].signature = new bytes(4097);
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
        bytes memory badOffset = abi.encode(message, uint256(type(uint256).max), uint256(0));
        assertFalse(app.check(address(account), hash, badOffset));
        // Canonical signature truncated by one word is never interpreted as a different valid tuple.
        bytes memory truncated = new bytes(sig.length - 32);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = sig[i];
        }
        assertFalse(app.check(address(account), hash, truncated));
    }

    function test_pendingCreationAndImplementationCannotAuthorizeApplications() public {
        bytes32 hash = keccak256("application");
        T.AccountSignature memory message = T.AccountSignature(initial.accountId, 3, 1, hash);
        bytes memory sig = abi.encode(
            message, _votes(policy, T.digest(block.chainid, address(account), T.hashAccountSignature(message)), P.SPEND)
        );
        assertFalse(app.check(address(implementation), hash, sig));
        bytes memory init = _initCode(initial, policy);
        // Factory-only step: not a valid EntryPoint activation. Creation is deliberately still pending.
        bytes memory input = new bytes(init.length - 20);
        for (uint256 i; i < input.length; ++i) {
            input[i] = init[i + 20];
        }
        vm.prank(factory.senderCreator());
        (bool created,) = address(factory).call(input);
        assertTrue(created);
        assertFalse(app.check(address(account), hash, sig));
        _create();
        assertTrue(app.check(address(account), hash, sig));
    }

    function test_rotationRevokesOldSignaturesEvenIfEnvelopeVersionIsUpdated() public {
        _create();
        bytes32 hash = keccak256("application");
        bytes memory sig = _signature(hash);
        T.SecurityPolicy memory next = _policy(carol, dave);
        (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs) =
            _executionChange(next, E.ChangeKind.Security);
        account.prepare(E.ChangeKind.Security, change, next, _chains(), _votes(policy, digest, P.ADMIN), proofs);
        assertTrue(app.check(address(account), hash, sig), "preparation is not activation");
        T.CommitProposal memory commit = _executionCommit();
        account.commit(commit, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(commit)), P.ADMIN));
        assertFalse(app.check(address(account), hash, sig));
        (T.AccountSignature memory message, S.Signature[] memory votes) =
            abi.decode(sig, (T.AccountSignature, S.Signature[]));
        message.securityVersion = account.securityVersion();
        assertFalse(app.check(address(account), hash, abi.encode(message, votes)));
        assertTrue(app.check(address(account), hash, _signature(hash)));
    }

    function test_callbackMayValidateAnApplicationSignatureDuringAuthorizedExecution() public {
        _create();
        bytes32 hash = keccak256("callback approval");
        T.Call[] memory calls = _calls(address(app), 0, abi.encodeCall(app.callback, (hash, _signature(hash))));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertTrue(app.callbackAccepted());
        assertFalse(account.executing());
    }

    function test_receivingAndWithdrawingNativeERC721AndERC1155NeedsNoOperatorService() public {
        _create();
        V3InteropNFT nft = new V3InteropNFT(address(account));
        V3InteropMultiToken multi = new V3InteropMultiToken(address(account));
        assertEq(nft.ownerOf(1), address(account));
        assertEq(multi.balanceOf(address(account), 1), 10);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        uint256[] memory values = new uint256[](2);
        values[0] = 20;
        values[1] = 30;
        T.Call[] memory calls = new T.Call[](4);
        calls[0] = T.Call(recipient, 1 ether, "");
        calls[1] = T.Call(
            address(nft),
            0,
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(account), recipient, 1)
        );
        calls[2] =
            T.Call(address(multi), 0, abi.encodeCall(multi.safeTransferFrom, (address(account), recipient, 1, 10, "")));
        calls[3] = T.Call(
            address(multi),
            0,
            abi.encodeCall(multi.safeBatchTransferFrom, (address(account), recipient, ids, values, ""))
        );
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 1 ether);
        assertEq(nft.ownerOf(1), recipient);
        for (uint256 id = 1; id <= 3; ++id) {
            assertEq(multi.balanceOf(address(account), id), 0);
            assertEq(multi.balanceOf(recipient, id), id * 10);
        }
    }

    function test_introspectionReportsImplementedInterfacesAndExactSigningDomain() public {
        _create();
        assertTrue(account.supportsInterface(type(IERC165).interfaceId));
        assertTrue(account.supportsInterface(type(IERC1271).interfaceId));
        assertTrue(account.supportsInterface(type(IERC5267).interfaceId));
        assertTrue(account.supportsInterface(type(IAccount).interfaceId));
        assertTrue(account.supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(account.supportsInterface(type(IERC1155Receiver).interfaceId));
        assertFalse(account.supportsInterface(0xffffffff));
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chain,
            address verifier,
            bytes32 salt,
            uint256[] memory extensions
        ) = account.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "GatoPago Account");
        assertEq(version, "3.0-consumer");
        assertEq(chain, block.chainid);
        assertEq(verifier, address(account));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
        bytes32 structHash = T.hashAccountSignature(_message(keccak256("domain")));
        bytes32 separator = keccak256(
            abi.encode(T.DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chain, verifier)
        );
        assertEq(keccak256(abi.encodePacked(hex"1901", separator, structHash)), T.digest(chain, verifier, structHash));
        vm.chainId(chain + 1);
        (,,, chain,,,) = account.eip712Domain();
        assertEq(chain, block.chainid);
    }

    function test_fixedLibraryDriftFailsClosed() public {
        _create();
        bytes32 hash = keccak256("application");
        bytes memory sig = _signature(hash);
        vm.etch(address(Security), hex"00");
        assertFalse(app.check(address(account), hash, sig));
    }

    function test_signatureTraceHasNoWritesLogsOrClockDependencies() public {
        _create();
        bytes32 hash = keccak256("trace");
        bytes memory sig = _signature(hash);
        vm.startDebugTraceRecording();
        assertTrue(app.check(address(account), hash, sig));
        Vm.DebugStep[] memory steps = vm.stopAndReturnDebugTraceRecording();
        uint256 accountSteps;
        uint256 libraryCalls;
        for (uint256 i; i < steps.length; ++i) {
            Vm.DebugStep memory step = steps[i];
            if (step.contractAddr != address(account)) continue;
            ++accountSteps;
            if (step.opcode == 0xf4 && address(uint160(step.stack[1])) == address(Security)) ++libraryCalls;
            assertFalse(step.opcode == 0x55 || step.opcode == 0x5d, "signature writes storage");
            assertFalse(step.opcode >= 0xa0 && step.opcode <= 0xa4, "signature emits log");
            assertFalse(step.opcode == 0x42 || step.opcode == 0x43, "signature reads clock");
        }
        assertGt(accountSteps, 0);
        assertEq(libraryCalls, 1);
    }

    function test_singleAndMultipleWebAuthnSignApplicationsAfterCreation() public {
        AccountV3WebAuthnVerifier verifier = new AccountV3WebAuthnVerifier();
        policy.signers[0] = T.SignerDescriptor(
            P.WEBAUTHN,
            address(verifier),
            address(verifier).codehash,
            abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), P256.GX, P256.GY),
            3
        );
        T.SecurityPolicy memory ordered = policy;
        _sort(ordered);
        policy = ordered;
        policy.spendThreshold = 2;
        initial = _initial(policy, keccak256("interop webauthn"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        _createWithSoftwareP256();
        bytes32 hash = keccak256("webauthn application");
        assertTrue(app.check(address(account), hash, _signature(hash)));
        T.SignerDescriptor memory passkey = policy.signers[policy.signers[0].kind == P.WEBAUTHN ? 0 : 1];
        policy.mode = P.ACTIVE;
        policy.adminThreshold = 1;
        policy.spendThreshold = 1;
        delete policy.signers;
        passkey.roles = P.SPEND | P.ADMIN;
        policy.signers.push(passkey);
        initial = _initial(policy, keccak256("interop bootstrap"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        _createWithSoftwareP256();
        assertTrue(app.check(address(account), hash, _signature(hash)));
    }

    function _createWithSoftwareP256() private {
        vm.deal(address(account), 10 ether);
        PackedUserOperation memory op = _operation(initial, policy, new T.Call[](0));
        // Characterization of software P-256; not a 500k bundler compatibility claim.
        op.accountGasLimits = bytes32((uint256(4_000_000) << 128) | 2_000_000);
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature =
            abi.encode(plan, _votes(policy, T.digest(block.chainid, address(account), T.hashExecution(plan)), P.SPEND));
        _submit(op);
    }
}
