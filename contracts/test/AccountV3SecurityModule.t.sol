// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {AccountV3SecurityModule as Module} from "src/v3/AccountV3SecurityModule.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {V3CreationFixture, V3InitializedSecurityHarness} from "test/helpers/V3CreationFixture.sol";
import {V3SecurityHarness} from "test/helpers/V3SecurityFixture.sol";

/// @dev Deliberately hostile fault-injection code, never a deployment candidate.
contract V3CorruptedSecurityModule {
    fallback(bytes calldata) external returns (bytes memory) {
        D.layout().adminNonce = 123456;
        return abi.encode(bytes32(uint256(1)));
    }
}

contract AccountV3SecurityModuleTest is V3CreationFixture {
    V3SecurityHarness private account;
    Module private moduleAccount;
    T.SecurityPolicy private policy;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        _setupCreation();
        policy = _policy(alice, bob);
        account = _createAccount(keccak256("linked security account A"));
        moduleAccount = Module(address(account));
    }

    function test_linkAddressAndCodeHashAreBoundToImplementation() public view {
        assertEq(moduleAccount.securityModule(), address(Security));
        assertEq(moduleAccount.securityModule(), implementation.securityModule());
        assertEq(moduleAccount.securityModuleCodeHash(), address(Security).codehash);
        assertEq(moduleAccount.securityModuleCodeHash(), implementation.securityModuleCodeHash());
        assertEq(moduleAccount.securityModuleCodeHash(), factory.securityModuleCodeHash());
        assertGt(address(Security).code.length, 0);
    }

    function test_fullCompositionAndLibraryRemainDeployable() public {
        // The production account keeps its 20k cap; extra test-only snapshot views are not shipped.
        assertLe(address(new AccountV3(address(ep))).code.length, 20_000, "production account budget");
        assertLe(address(implementation).code.length, 24_576, "test observation harness EIP-170 cap");
        assertLe(address(Security).code.length, 24_576, "linked library must also satisfy EIP-170");
        assertLe(type(V3InitializedSecurityHarness).creationCode.length + 32, 49_152, "EIP-3860 initcode cap");
    }

    function test_policyReadReturnsCanonicalFormatAndRejectsLibraryDrift() public {
        assertEq(abi.encode(moduleAccount.securityPolicy()), abi.encode(policy));
        vm.etch(address(Security), type(V3CorruptedSecurityModule).runtimeCode);
        vm.expectRevert(Module.AccountV3SecurityModule__CodeChanged.selector);
        moduleAccount.securityPolicy();
        vm.expectRevert(Module.AccountV3SecurityModule__CodeChanged.selector);
        moduleAccount.securitySnapshot();
    }

    function test_securitySnapshotIsPublicReadOnlyAndMatchesCanonicalStorage() public {
        bytes32 before_ = _fingerprint(account);
        V3SecurityHarness.Snapshot memory expected = account.snapshot();
        vm.record();
        vm.recordLogs();
        vm.prank(makeAddr("independent-security-reader"));
        uint256[16] memory seen = moduleAccount.securitySnapshot();
        (, bytes32[] memory writes) = vm.accesses(address(account));
        assertEq(writes.length, 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(seen[0], 1);
        assertEq(seen[1], expected.version);
        assertEq(bytes32(seen[2]), expected.manifest);
        assertEq(bytes32(seen[3]), expected.scope);
        assertEq(seen[7], expected.admin);
        assertEq(seen[8], 1);
        assertEq(seen[6], expected.spend);
        assertEq(seen[4], 0);
        assertEq(seen[5], 0);
        assertEq(seen[9], 0);
        assertEq(seen[10], 0);
        assertEq(_fingerprint(account), before_);
    }

    function test_snapshotOfImplementationIsNotInitialized() public view {
        uint256[16] memory seen = implementation.securitySnapshot();
        assertEq(seen[0], 0);
        assertEq(seen[1], 0);
    }

    function test_snapshotRetainsSecurityProposalAndFreezeEvenAfterProposalExpiry() public {
        _freeze(account);
        T.SecurityPolicy memory next = _policy(carol, dave);
        T.SecurityChange memory change = _change(account, next, E.ChangeKind.Security);
        account.prepare(
            E.ChangeKind.Security,
            change,
            next,
            _chains(),
            _votes(policy, T.digest(block.chainid, address(account), T.hashSecurity(change)), P.ADMIN),
            _proofs(account, next, change, E.ChangeKind.Security)
        );
        V3SecurityHarness.Snapshot memory expected = account.snapshot();
        vm.warp(expected.pending.validUntil + 1);
        bytes32 before_ = _fingerprint(account);
        uint256[16] memory seen = moduleAccount.securitySnapshot();
        assertEq(seen[0], 3);
        assertEq(seen[9], uint8(D.ProposalKind.Security));
        assertEq(bytes32(seen[10]), expected.pending.proposalHash);
        assertEq(seen[11], expected.version);
        assertEq(bytes32(seen[12]), expected.manifest);
        assertEq(bytes32(seen[13]), expected.pending.chainScopeHash);
        assertEq(seen[14], expected.pending.readyAt);
        assertEq(seen[15], expected.pending.validUntil);
        assertEq(seen[7], 2);
        assertEq(seen[8], 1);
        assertEq(_fingerprint(account), before_);
        account.expire(bytes32(seen[10]));
        assertEq(moduleAccount.securitySnapshot()[9], 0);
    }

    function test_initialPolicyInstallerCannotBeCalledDirectlyOrThroughAccountDispatch() public {
        T.InitializationApproval memory initial = _initial(policy, keccak256("cannot bypass initialize"));
        bytes memory data = abi.encodeWithSelector(
            Security.installInitialPolicy.selector,
            initial,
            policy,
            _chains(),
            _initialProofs(initial, policy),
            initial.entryPoint
        );
        bytes32 before_ = _fingerprint(account);
        (bool libraryCall,) = address(Security).call(data);
        assertFalse(libraryCall);
        (bool accountCall,) = address(account).call(data);
        assertFalse(accountCall);
        assertEq(_fingerprint(account), before_);
    }

    function test_missingLibraryRejectsImplementationConstruction() public {
        vm.etch(address(Security), "");
        vm.expectRevert(Module.AccountV3SecurityModule__MissingCode.selector);
        new V3InitializedSecurityHarness(address(ep));
    }

    function test_factoryCannotCaptureDriftAfterImplementationConstruction() public {
        vm.etch(address(Security), type(V3CorruptedSecurityModule).runtimeCode);
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__InvalidDeployment.selector);
        new AccountFactoryV3(address(implementation), address(ep));
    }

    function test_factoryRejectsImplementationReportingAnotherLibrary() public {
        vm.mockCall(address(implementation), abi.encodeCall(Module.securityModule, ()), abi.encode(address(ep)));
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__InvalidDeployment.selector);
        new AccountFactoryV3(address(implementation), address(ep));
    }

    function test_allTypedEntrypointsFailClosedOnCodeReplacement() public {
        bytes memory originalCode = address(Security).code;
        bytes32 before_ = _fingerprint(account);
        for (uint8 action; action < 6; ++action) {
            bytes memory data = _transition(action, false);
            vm.etch(address(Security), type(V3CorruptedSecurityModule).runtimeCode);
            (bool success, bytes memory result) = address(account).call(data);
            assertFalse(success);
            assertEq(result, abi.encodeWithSelector(Module.AccountV3SecurityModule__CodeChanged.selector));
            // Restore only code, NEVER storage. The canonical read itself also fails closed
            // on drift; after restoring the reader, verify that no authority state changed.
            vm.etch(address(Security), originalCode);
            assertEq(_fingerprint(account), before_);
        }
    }

    function testFuzz_missingOrArbitraryLibraryCodeFailsBeforeDelegation(bytes memory runtimeCode, uint8 action)
        public
    {
        // Code corruption is fault injection, not a claim that EVM code is normally mutable.
        vm.assume(keccak256(runtimeCode) != moduleAccount.securityModuleCodeHash());
        bytes memory originalCode = address(Security).code;
        bytes32 before_ = _fingerprint(account);
        bytes memory data = _transition(action % 6, false);
        vm.etch(address(Security), runtimeCode);
        (bool success, bytes memory result) = address(account).call(data);
        assertFalse(success);
        assertEq(result, abi.encodeWithSelector(Module.AccountV3SecurityModule__CodeChanged.selector));
        vm.etch(address(Security), originalCode);
        assertEq(_fingerprint(account), before_);
    }

    function test_directLibraryCallsAreRejectedByCompilerContextGuard() public {
        for (uint8 action; action < 6; ++action) {
            // Library selectors may encode Solidity type names, not the wrapper's external ABI.
            (bool success, bytes memory result) = address(Security).call(_transition(action, true));
            assertFalse(success);
            assertEq(result.length, 0, "direct CALL must fail before the library's state checks");
        }
    }

    function test_sharedLibraryDoesNotShareAuthorityStateOrEvents() public {
        V3SecurityHarness other = _createAccount(keccak256("linked security account B"));
        bytes32 otherBefore = _fingerprint(other);
        vm.recordLogs();
        _freeze(account);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(account));
        assertTrue(account.snapshot().frozen);
        assertEq(account.snapshot().admin, 1);
        assertEq(_fingerprint(other), otherBefore);
        assertEq(vm.load(address(Security), D.STORAGE_LOCATION), bytes32(0));
        assertEq(vm.load(address(Security), bytes32(uint256(D.STORAGE_LOCATION) + 7)), bytes32(0));
    }

    function test_signatureForLibraryDomainCannotAuthorizeProxy() public {
        T.FreezeUpgrades memory message = _freezeMessage(account);
        S.Signature[] memory wrongDomain =
            _votes(policy, T.digest(block.chainid, address(Security), T.hashFreeze(message)), P.ADMIN);
        bytes32 before_ = _fingerprint(account);
        uint256[] memory chains = _chains();
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.freeze(message, chains, wrongDomain);
        assertEq(_fingerprint(account), before_);
        _freeze(account);
        assertTrue(account.snapshot().frozen);
    }

    function _createAccount(bytes32 salt) private returns (V3SecurityHarness) {
        T.InitializationApproval memory initial = _initial(policy, salt);
        return _create(initial, policy, _chains(), _initialProofs(initial, policy));
    }

    function _transition(uint8 action, bool librarySelector) private view returns (bytes memory) {
        S.Signature[] memory noSignatures = new S.Signature[](0);
        if (action == 0) {
            T.SecurityPolicy memory next = _policy(alice, carol);
            T.SecurityChange memory message = _change(account, next, E.ChangeKind.Security);
            return abi.encodeWithSelector(
                librarySelector ? Security.prepare.selector : Module.prepare.selector,
                E.ChangeKind.Security,
                message,
                next,
                _chains(),
                noSignatures,
                noSignatures
            );
        }
        if (action == 1) {
            T.CommitProposal memory message;
            return abi.encodeWithSelector(
                librarySelector ? Security.commitPolicy.selector : Module.commit.selector, message, noSignatures
            );
        }
        if (action == 2) {
            return abi.encodeWithSelector(
                librarySelector ? Security.cancel.selector : Module.cancel.selector,
                T.CancelProposal(bytes32(0), 3, 1, bytes32(uint256(1)), 0, 1, 2),
                noSignatures
            );
        }
        if (action == 3) {
            T.CancelProposal memory message;
            return abi.encodeWithSelector(
                librarySelector ? Security.cancel.selector : Module.cancel.selector, message, noSignatures
            );
        }
        if (action == 4) {
            return abi.encodeWithSelector(
                librarySelector ? Security.freezeUpgrades.selector : Module.freeze.selector,
                _freezeMessage(account),
                _chains(),
                noSignatures
            );
        }
        return abi.encodeWithSelector(
            librarySelector ? Security.expire.selector : Module.expire.selector, bytes32(uint256(1))
        );
    }
}
