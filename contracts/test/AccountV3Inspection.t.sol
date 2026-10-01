// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountFactoryV3 as Factory} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Initializable} from "src/v3/AccountV3Initializable.sol";
import {AccountV3Upgrade as Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Old partial creation composition is intentionally NOT an admissible factory target.
contract V3PartialCreationFixture is AccountV3Initializable {
    constructor(address ep) AccountV3Initializable(ep) {}
}

contract V3WrongLayoutFixture is AccountV3 {
    constructor(address ep) AccountV3(ep) {}

    function storageLayoutHash() public pure override returns (bytes32) {
        return bytes32(uint256(123));
    }
}

/// @dev Any delegated metadata call to this target is a test failure: slot/code checking comes first.
contract V3UnknownInspectionTarget {
    error MustNotCallUnknownTarget();

    fallback() external {
        revert MustNotCallUnknownTarget();
    }
}

contract AccountV3InspectionTest is V3ExecutionFixture {
    function setUp() external {
        _setupExecution();
    }

    function test_factoryCapturesBothFixedModules() external view {
        assertEq(factory.securityModuleCodeHash(), address(Security).codehash);
        assertEq(factory.upgradeModuleCodeHash(), address(Upgrade).codehash);
        assertEq(factory.implementationCodeHash(), address(implementation).codehash);
        assertEq(factory.entryPointCodeHash(), address(ep).codehash);
    }

    function test_factoryRejectsPartialCompositionAndWrongInitialLayout() external {
        V3PartialCreationFixture incomplete = new V3PartialCreationFixture(address(ep));
        vm.expectRevert(); // Missing full composition ABI, never admitted as an Account V3.
        new Factory(address(incomplete), address(ep));
        V3WrongLayoutFixture wrong = new V3WrongLayoutFixture(address(ep));
        vm.expectRevert(Factory.AccountFactoryV3__InvalidDeployment.selector);
        new Factory(address(wrong), address(ep));
    }

    function testFuzz_constructorCannotRecaptureDriftOrMisreportedUpgradeMetadata(uint8 variant) external {
        uint8 mode = variant % 5;
        if (mode < 2) {
            vm.etch(address(Upgrade), mode == 0 ? bytes("") : bytes(hex"60006000fd"));
        } else if (mode == 2) {
            vm.mockCall(
                address(implementation), abi.encodeCall(implementation.upgradeModule, ()), abi.encode(address(9))
            );
        } else if (mode == 3) {
            vm.mockCall(
                address(implementation),
                abi.encodeCall(implementation.upgradeModuleCodeHash, ()),
                abi.encode(bytes32(uint256(9)))
            );
        } else {
            vm.mockCall(
                address(implementation), abi.encodeCall(implementation.proxiableUUID, ()), abi.encode(bytes32(0))
            );
        }
        vm.expectRevert(Factory.AccountFactoryV3__InvalidDeployment.selector);
        new Factory(address(implementation), address(ep));
    }

    function testFuzz_counterfactualLookupNeverCreatesOrClaimsDeployed(bytes32 salt) external {
        address predicted = factory.getAddress(initial.initialSecurityCommitment, salt);
        Factory.ImplementationExpectation memory expected = _expectation(address(implementation));
        vm.expectRevert(Factory.AccountFactoryV3__AccountNotDeployed.selector);
        factory.inspectAccount(initial.initialSecurityCommitment, salt, expected);
        assertEq(predicted.code.length, 0);
        assertEq(vm.getNonce(predicted), 0);
    }

    function test_inspectionIsReadOnlyAndDoesNotClaimPendingCreationIsSpendReady() external {
        // Fault injection isolates the legitimate CREATE2/init phase before real EP validation.
        bytes memory code = _initCode(initial, policy);
        bytes memory input = new bytes(code.length - 20);
        for (uint256 i; i < input.length; ++i) {
            input[i] = code[i + 20];
        }
        vm.prank(address(ep.senderCreator()));
        (bool created,) = address(factory).call(input);
        assertTrue(created);
        bytes32 before_ = _snapshot();
        Factory.AccountInspection memory seen = _inspect(_expectation(address(implementation)));
        assertEq(seen.account, address(account));
        assertEq(seen.accountId, initial.accountId);
        assertEq(seen.securityVersion, 1);
        assertEq(seen.storageLayoutHash, D.LAYOUT_HASH);
        assertEq(_snapshot(), before_);
        vm.expectRevert(Security.AccountV3Security__CreationPending.selector);
        account.expire(bytes32(0));
    }

    function test_actualUpgradeChangesInspectionTargetNotAddressOrFactoryAuthority() external {
        _create();
        address original = address(account);
        V3ExecutionAccount next = new V3ExecutionAccount(address(ep));
        _upgrade(address(next));
        Factory.ImplementationExpectation memory stale = _expectation(address(implementation));
        vm.expectRevert(Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector);
        _inspect(stale);
        bytes32 before_ = _snapshot();
        Factory.AccountInspection memory seen = _inspect(_expectation(address(next)));
        assertEq(seen.account, original);
        assertEq(seen.implementation, address(next));
        assertEq(seen.securityVersion, 2);
        assertEq(factory.implementation(), address(implementation));
        assertEq(factory.getAddress(initial.initialSecurityCommitment, initial.userSaltCommitment), original);
        assertEq(_snapshot(), before_);
        // Old initializer is not the read path and must not overwrite the upgraded implementation.
        T.InitializationApproval memory old = initial;
        uint256[] memory chains = _chains();
        address creator = address(ep.senderCreator());
        vm.expectRevert(Factory.AccountFactoryV3__ExistingAccountMismatch.selector);
        vm.prank(creator);
        factory.createAccount(old, policy, chains, new S.Signature[](0));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(_calls(recipient, 1, ""));
        account.executeSigned(_calls(recipient, 1, ""), plan, votes);
        assertEq(recipient.balance, 1);
    }

    function test_retiredInitialImplementationDoesNotBlockInspectingOrSpendingUpgradedAccount() external {
        _create();
        V3ExecutionAccount next = new V3ExecutionAccount(address(ep));
        _upgrade(address(next));
        Factory.ImplementationExpectation memory expected = _expectation(address(next));
        vm.etch(address(implementation), ""); // An unused historical dependency, not current account code.
        assertEq(_inspect(expected).implementation, address(next));
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 1);
    }

    function testFuzz_everyExpectedArtifactFieldIsEnforced(uint8 variant) external {
        _create();
        Factory.ImplementationExpectation memory expected = _expectation(address(implementation));
        uint8 mode = variant % 7;
        if (mode == 0) expected.implementation = address(42);
        else if (mode == 1) expected.runtimeCodeHash = bytes32(uint256(42));
        else if (mode == 2) expected.storageLayoutHash = bytes32(uint256(42));
        else if (mode == 3) expected.securityModule = address(42);
        else if (mode == 4) expected.securityModuleCodeHash = bytes32(uint256(42));
        else if (mode == 5) expected.upgradeModule = address(42);
        else expected.upgradeModuleCodeHash = bytes32(uint256(42));
        vm.expectRevert(Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector);
        _inspect(expected);
    }

    function test_unknownTargetIsRejectedBeforeAnyDelegatedGetter() external {
        _create();
        Factory.ImplementationExpectation memory expected = _expectation(address(implementation));
        V3UnknownInspectionTarget unknown = new V3UnknownInspectionTarget();
        vm.store(address(account), ERC1967Utils.IMPLEMENTATION_SLOT, bytes32(uint256(uint160(address(unknown)))));
        vm.expectRevert(Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector);
        _inspect(expected);
        // The right address but a wrong codehash is insufficient too.
        expected.implementation = address(unknown);
        vm.expectRevert(Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector);
        _inspect(expected);
    }

    function testFuzz_proxyIdentityAndCurrentDependencyDriftRejects(uint8 variant) external {
        _create();
        Factory.ImplementationExpectation memory expected = _expectation(address(implementation));
        uint8 mode = variant % 5;
        if (mode == 0) vm.etch(address(account), hex"60006000fd");
        else if (mode == 1) vm.store(address(account), bytes32(uint256(D.STORAGE_LOCATION) + 1), bytes32(uint256(1)));
        else if (mode == 2) vm.etch(address(implementation), hex"60006000fd");
        else if (mode == 3) vm.etch(address(Security), hex"60006000fd");
        else vm.etch(address(Upgrade), hex"60006000fd");
        vm.expectRevert(
            mode < 2
                ? Factory.AccountFactoryV3__ExistingAccountMismatch.selector
                : Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector
        );
        _inspect(expected);
    }

    function test_upgradeDependencyFailureDoesNotDisableDirectExit() external {
        _create();
        Factory.ImplementationExpectation memory expected = _expectation(address(implementation));
        vm.etch(address(Upgrade), "");
        vm.expectRevert(Factory.AccountFactoryV3__UnexpectedCurrentImplementation.selector);
        _inspect(expected);
        // Inspection of the FULL profile fails, but direct spending does not depend on Upgrade.
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 1);
    }

    function test_recoveryAndFreezeCannotBeClearedByInspection() external {
        _create();
        T.FreezeUpgrades memory freeze = _executionFreeze();
        account.freeze(
            freeze, _chains(), _votes(policy, T.digest(block.chainid, address(account), T.hashFreeze(freeze)), P.ADMIN)
        );
        T.SecurityPolicy memory replacement = _policy(carol, dave);
        (T.SecurityChange memory change,, S.Signature[] memory proofs) =
            _executionChange(replacement, E.ChangeKind.Security);
        account.prepare(
            E.ChangeKind.Security,
            change,
            replacement,
            _chains(),
            _votes(policy, T.digest(block.chainid, address(account), T.hashSecurity(change)), P.ADMIN),
            proofs
        );
        bytes32 before_ = _snapshot();
        _inspect(_expectation(address(implementation)));
        assertEq(_snapshot(), before_);
    }

    function _expectation(address target) private view returns (Factory.ImplementationExpectation memory) {
        // Test fixture only. Production MUST obtain these from an independently admitted manifest,
        // never learn the expected hashes from the very RPC observation being checked.
        return Factory.ImplementationExpectation(
            target,
            target.codehash,
            D.LAYOUT_HASH,
            address(Security),
            address(Security).codehash,
            address(Upgrade),
            address(Upgrade).codehash
        );
    }

    function _inspect(Factory.ImplementationExpectation memory expected)
        private
        view
        returns (Factory.AccountInspection memory)
    {
        return factory.inspectAccount(initial.initialSecurityCommitment, initial.userSaltCommitment, expected);
    }

    function _upgrade(address target) private {
        (bytes32 manifest, uint256 nonce,,) = account.securityState();
        T.UpgradeManifest memory message = T.UpgradeManifest(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            target,
            target.codehash,
            D.LAYOUT_HASH,
            keccak256(abi.encode(_chains())),
            keccak256(""),
            nonce,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 10 days)
        );
        account.proposeUpgrade(
            message,
            _chains(),
            _votes(policy, T.digest(block.chainid, address(account), T.hashUpgrade(message)), P.ADMIN)
        );
        vm.warp(block.timestamp + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        account.commitUpgrade(
            commit, "", _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(commit)), P.ADMIN)
        );
    }

    function _snapshot() private view returns (bytes32) {
        (bytes32 manifest, uint256 admin, uint256 recovery, bool frozen) = account.securityState();
        (bytes32 proposal, uint8 kind) = account.proposal();
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) = account.creationIdentity();
        return keccak256(
            abi.encode(
                generation,
                id,
                commitment,
                salt,
                manifest,
                admin,
                recovery,
                frozen,
                proposal,
                kind,
                account.securityVersion(),
                account.directNonce(),
                address(account).balance
            )
        );
    }
}
