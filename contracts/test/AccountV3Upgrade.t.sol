// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Upgrade as Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Reviewed-fixture-style namespace extension; no change to the base V3 layout.
contract V3UpgradeRevision is V3ExecutionAccount {
    // Separate new namespace, never an ordinary slot that can collide with the account.
    bytes32 private constant MARKER_SLOT = keccak256("gatopago.test.upgrade.marker");
    constructor(address ep) V3ExecutionAccount(ep) {}

    function migrate(uint256 value) external onlyUpgradeMigration {
        bytes32 slot = MARKER_SLOT;
        assembly ("memory-safe") { sstore(slot, value) }
    }

    function marker() external view returns (uint256 value) {
        bytes32 slot = MARKER_SLOT;
        assembly ("memory-safe") { value := sload(slot) }
    }

    function migrateAndCall(address callback) external onlyUpgradeMigration {
        V3UpgradeCallback(callback).attempt(address(this));
    }
}

/// @dev Deliberately hostile migration; compatibility metadata is NOT proof of safe code.
contract V3CorruptingUpgrade is V3ExecutionAccount {
    error MigrationFailed();
    constructor(address ep) V3ExecutionAccount(ep) {}

    function corrupt(uint8 variant) external onlyUpgradeMigration {
        if (variant == 0) {
            D.layout().initialSecurityCommitment = bytes32(uint256(1));
        } else if (variant == 1) {
            D.layout().securityVersion = 1;
        } else if (variant == 2) {
            D.layout().adminNonce = 0;
        } else if (variant == 3) {
            D.layout().executing = false;
        } else if (variant == 4) {
            D.layout().policy.adminThreshold = 1;
        } else if (variant == 5) {
            D.layout().upgradesFrozen = true;
        } else if (variant == 6) {
            bytes32 slot = ERC1967Utils.IMPLEMENTATION_SLOT;
            assembly ("memory-safe") { sstore(slot, 0) }
        } else {
            revert MigrationFailed();
        }
    }
}

contract V3UpgradeToken is ERC20 {
    constructor(address recipient) ERC20("V3 upgrade fixture", "V3U") {
        _mint(recipient, 100);
    }
}

contract V3UpgradeCallback {
    bool public rejected;
    bytes public payload;

    function configure(bytes calldata input) external {
        payload = input;
    }

    function attempt(address account) external {
        (bool success,) = account.call(payload);
        rejected = !success;
    }
}

/// @dev Valid UUPS UUID, adversarial compatibility response lengths/gas/reverts.
contract V3UpgradeBadMetadata {
    uint8 private immutable mode;

    constructor(uint8 mode_) {
        mode = mode_;
    }

    function proxiableUUID() external view returns (bytes32) {
        return mode == 5 ? bytes32(uint256(1)) : ERC1967Utils.IMPLEMENTATION_SLOT;
    }

    fallback() external {
        uint8 m = mode;
        assembly ("memory-safe") {
            switch m
            case 0 { revert(0, 0) }
            case 1 { return(0, 0) }
            case 2 {
                mstore(0, 1)
                return(0, 1)
            }
            case 3 {
                mstore(0, 1)
                mstore(32, 1)
                return(0, 64)
            }
            case 4 { for {} 1 {} {} }
            default { return(0, 0) }
        }
    }
}

contract AccountV3UpgradeTest is V3ExecutionFixture {
    V3ExecutionAccount internal next;

    function setUp() external {
        _setupExecution();
        _create();
        next = new V3ExecutionAccount(address(ep));
    }

    function test_upgradePreservesAccountAssetsKeysAndNoncesAndInvalidatesOldSignatures() external {
        V3UpgradeToken token = new V3UpgradeToken(address(account));
        T.Call[] memory calls = _calls(recipient, 0.1 ether, "");
        (T.ExecutionPlan memory oldPlan, S.Signature[] memory oldVotes) = _direct(calls);
        uint256 balance = address(account).balance;
        bytes32 policyHash = T.hashPolicy(account.securityPolicy());
        T.UpgradeManifest memory message = _message(address(next), "");
        _queue(message);
        vm.warp(START + 72 hours);
        _apply("");
        assertEq(_implementation(), address(next));
        assertEq(account.securityVersion(), 2);
        assertEq(account.directNonce(), 0);
        (bytes32 manifest, uint256 admin,,) = account.securityState();
        assertEq(admin, 2);
        assertEq(
            manifest,
            T.hashManifest(
                T.SecurityManifest(
                    initial.accountId, 3, 2, message.previousManifestHash, policyHash, message.chainScopeHash
                )
            )
        );
        assertEq(T.hashPolicy(account.securityPolicy()), policyHash);
        assertEq(address(account).balance, balance);
        assertEq(token.balanceOf(address(account)), 100);
        vm.expectRevert();
        account.executeSigned(calls, oldPlan, oldVotes);
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertEq(recipient.balance, 0.1 ether);
        _submit(
            _operation(initial, policy, _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 100))))
        );
        assertEq(token.balanceOf(recipient), 100);
    }

    function test_standardUpgradeSelectorCannotBypassTypedConsentEvenFromEntryPoint() external {
        address[3] memory callers = [alice, address(ep), address(account)];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(AccountV3.AccountV3__TypedUpgradeRequired.selector);
            vm.prank(callers[i]);
            account.upgradeToAndCall(address(next), "");
        }
        assertEq(_implementation(), address(implementation));
    }

    function test_implementationAndProxyCannotBeUsedAsProxiableTargets() external {
        assertEq(next.proxiableUUID(), ERC1967Utils.IMPLEMENTATION_SLOT);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        account.proxiableUUID();
        T.UpgradeManifest memory message = _message(address(next), "");
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        next.proposeUpgrade(message, _chains(), new S.Signature[](0));
    }

    function testFuzz_waitStartsAtAcceptanceAndCannotBeBackdated(uint32 backdate, uint32 elapsed) external {
        backdate = uint32(bound(backdate, 1, 30 days));
        elapsed = uint32(bound(elapsed, 0, 72 hours - 1));
        T.UpgradeManifest memory message = _message(address(next), "");
        message.validAfter = START - backdate;
        _queue(message);
        vm.warp(START + elapsed);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        vm.expectRevert(Security.AccountV3Security__ProposalNotReady.selector);
        account.commitUpgrade(commit, "", votes);
        assertEq(_implementation(), address(implementation));
    }

    function test_noProposalOverwriteAndNoProposalWhoseWaitEndsAtExpiry() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        message.validUntil = START + 72 hours;
        S.Signature[] memory votes = _upgradeVotes(message);
        vm.expectRevert(Security.AccountV3Security__TimelockExceedsValidity.selector);
        account.proposeUpgrade(message, _chains(), votes);
        message.validUntil += 1;
        _queue(message);
        T.UpgradeManifest memory second = _message(address(next), "");
        votes = _upgradeVotes(second);
        vm.expectRevert(Security.AccountV3Security__PendingProposal.selector);
        account.proposeUpgrade(second, _chains(), votes);
    }

    function test_missingDuplicateAndWrongPurposeSignaturesDoNotQueueUpgrade() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        S.Signature[] memory all = _upgradeVotes(message);
        S.Signature[] memory one = new S.Signature[](1);
        one[0] = all[0];
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.proposeUpgrade(message, _chains(), one);
        all[1] = all[0];
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.proposeUpgrade(message, _chains(), all);
        T.FreezeUpgrades memory freeze = _executionFreeze();
        all = _votes(policy, T.digest(block.chainid, address(account), T.hashFreeze(freeze)), P.ADMIN);
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.proposeUpgrade(message, _chains(), all);
        (, uint256 nonce,,) = account.securityState();
        assertEq(nonce, 0);
    }

    function test_commitNeedsFreshQuorumAndCannotUseOrdinaryPolicyCommit() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        S.Signature[] memory proposalVotes = _upgradeVotes(message);
        _queue(message);
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.commitUpgrade(commit, "", proposalVotes);
        S.Signature[] memory votes = _commitVotes(commit);
        vm.expectRevert(Security.AccountV3Security__WrongProposal.selector);
        account.commit(commit, votes);
        account.commitUpgrade(commit, "", votes);
        vm.expectRevert(Security.AccountV3Security__StaleVersion.selector);
        account.commitUpgrade(commit, "", votes);
    }

    function test_validSpendOnlySignerCannotCountAsAnAdminVote() external {
        T.SecurityPolicy memory replacement = _policy(carol, dave);
        T.SignerDescriptor[] memory members = new T.SignerDescriptor[](3);
        members[0] = replacement.signers[0];
        members[1] = replacement.signers[1];
        members[0].roles = P.ADMIN;
        members[1].roles = P.ADMIN;
        members[2] = _ecdsa(alice);
        members[2].roles = P.SPEND;
        replacement.signers = members;
        _sort(replacement);
        (T.SecurityChange memory change, bytes32 changeDigest, S.Signature[] memory proofs) =
            _executionChange(replacement, E.ChangeKind.Security);
        account.prepare(
            E.ChangeKind.Security, change, replacement, _chains(), _votes(policy, changeDigest, P.ADMIN), proofs
        );
        T.CommitProposal memory commit = _executionCommit();
        account.commit(commit, _commitVotes(commit));
        T.UpgradeManifest memory message = _message(address(next), "");
        bytes32 digest = T.digest(block.chainid, address(account), T.hashUpgrade(message));
        S.Signature[] memory wrongRoles = new S.Signature[](2);
        wrongRoles[0] = _votes(replacement, digest, P.SPEND)[0];
        wrongRoles[1] = _votes(replacement, digest, P.ADMIN)[0];
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.proposeUpgrade(message, _chains(), wrongRoles);
    }

    function testFuzz_manifestIdentityVersionPredecessorAndNonceAreChecked(uint8 variant) external {
        variant = uint8(bound(variant, 0, 5));
        T.UpgradeManifest memory message = _message(address(next), "");
        if (variant == 0) message.accountId = bytes32(uint256(1));
        else if (variant == 1) message.generation = 4;
        else if (variant == 2) ++message.securityVersion;
        else if (variant == 3) message.previousManifestHash = bytes32(uint256(1));
        else if (variant == 4) ++message.nonce;
        else message.validUntil = START;
        S.Signature[] memory votes = _upgradeVotes(message);
        vm.expectRevert();
        account.proposeUpgrade(message, _chains(), votes);
        (, uint256 nonce,,) = account.securityState();
        assertEq(nonce, 0);
    }

    function test_crossChainScopeAndSignatureReplayFail() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        S.Signature[] memory votes = _upgradeVotes(message);
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        uint256[] memory previousChains = new uint256[](1);
        previousChains[0] = originalChain;
        vm.expectRevert(Security.AccountV3Security__WrongScope.selector);
        account.proposeUpgrade(message, previousChains, votes);
        message.chainScopeHash = keccak256(abi.encode(_chains()));
        vm.expectRevert(Security.AccountV3Security__InvalidConsent.selector);
        account.proposeUpgrade(message, _chains(), votes);
    }

    function testFuzz_targetCodeLayoutEntryPointAndUupsAreValidated(uint8 variant) external {
        _assertInvalidTarget(uint8(bound(variant, 0, 7)));
    }

    function test_targetRejectsZeroAddress() external {
        _assertInvalidTarget(0);
    }

    function test_targetRejectsAddressWithoutCode() external {
        _assertInvalidTarget(1);
    }

    function test_targetRejectsAccountProxy() external {
        _assertInvalidTarget(2);
    }

    function test_targetRejectsCurrentImplementation() external {
        _assertInvalidTarget(3);
    }

    function test_targetRejectsWrongRuntimeCodeHash() external {
        _assertInvalidTarget(4);
    }

    function test_targetRejectsWrongStorageLayoutHash() external {
        _assertInvalidTarget(5);
    }

    function test_targetRejectsWrongEntryPoint() external {
        _assertInvalidTarget(6);
    }

    function test_targetRejectsNonUupsContract() external {
        _assertInvalidTarget(7);
    }

    function _assertInvalidTarget(uint8 variant) internal {
        assertLe(variant, 7);
        T.UpgradeManifest memory message = _message(address(next), "");
        if (variant == 0) {
            message.implementation = address(0);
        } else if (variant == 1) {
            message.implementation = alice;
        } else if (variant == 2) {
            message.implementation = address(account);
        } else if (variant == 3) {
            message.implementation = address(implementation);
        } else if (variant == 4) {
            message.runtimeCodeHash = bytes32(uint256(1));
        } else if (variant == 5) {
            message.storageLayoutHash = bytes32(uint256(1));
        } else if (variant == 6) {
            message.implementation = address(new V3ExecutionAccount(address(factory)));
            message.runtimeCodeHash = message.implementation.codehash;
        } else {
            message.implementation = address(new V3UpgradeToken(address(account)));
            message.runtimeCodeHash = message.implementation.codehash;
        }
        S.Signature[] memory votes = _upgradeVotes(message);
        bytes32 snapshot = _snapshot();
        vm.expectRevert(Upgrade.AccountV3Upgrade__InvalidTarget.selector);
        account.proposeUpgrade(message, _chains(), votes);
        assertEq(_snapshot(), snapshot);
    }

    function testFuzz_metadataCallRejectsRevertsShortLongAndGasBombs(uint8 mode) external {
        mode = uint8(bound(mode, 0, 5));
        T.UpgradeManifest memory message = _message(address(new V3UpgradeBadMetadata(mode)), "");
        S.Signature[] memory votes = _upgradeVotes(message);
        vm.expectRevert(Upgrade.AccountV3Upgrade__InvalidTarget.selector);
        account.proposeUpgrade(message, _chains(), votes);
    }

    function test_codeDriftAfterProposalCannotConsumeCommit() external {
        _queue(_message(address(next), ""));
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        vm.etch(address(next), hex"00");
        vm.expectRevert(Upgrade.AccountV3Upgrade__InvalidTarget.selector);
        account.commitUpgrade(commit, "", votes);
        (, uint256 nonce,,) = account.securityState();
        assertEq(nonce, 1);
        assertEq(account.securityVersion(), 1);
    }

    function test_exactMigrationRunsAtomicallyAndOnlyDuringUpgrade() external {
        V3UpgradeRevision revision = new V3UpgradeRevision(address(ep));
        bytes memory migration = abi.encodeCall(revision.migrate, (42));
        _queue(_message(address(revision), migration));
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        vm.expectRevert(Upgrade.AccountV3Upgrade__InvalidMigration.selector);
        account.commitUpgrade(commit, abi.encodeCall(revision.migrate, (43)), votes);
        account.commitUpgrade(commit, migration, votes);
        assertEq(V3UpgradeRevision(payable(address(account))).marker(), 42);
        vm.expectRevert(AccountV3.AccountV3__TypedUpgradeRequired.selector);
        V3UpgradeRevision(payable(address(account))).migrate(43);
        assertFalse(account.executing());
        V3UpgradeCallback callback = new V3UpgradeCallback();
        callback.configure(migration);
        T.Call[] memory calls = _calls(address(callback), 0, abi.encodeCall(callback.attempt, (address(account))));
        (T.ExecutionPlan memory plan, S.Signature[] memory spendingVotes) = _direct(calls);
        account.executeSigned(calls, plan, spendingVotes);
        assertTrue(callback.rejected());
        assertEq(V3UpgradeRevision(payable(address(account))).marker(), 42);
    }

    function test_minimalMigrationThenTokenSendRotationAndDirectExit() external {
        V3UpgradeToken token = new V3UpgradeToken(address(account));
        V3UpgradeRevision revision = new V3UpgradeRevision(address(ep));
        bytes memory migration = abi.encodeCall(revision.migrate, (42));
        _queue(_message(address(revision), migration));
        vm.warp(START + 72 hours);
        _apply(migration);
        _submit(_operation(initial, policy, _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 25)))));
        assertEq(token.balanceOf(recipient), 25);

        T.SecurityPolicy memory replacement = _policy(carol, dave);
        (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs) =
            _executionChange(replacement, E.ChangeKind.Security);
        account.prepare(
            E.ChangeKind.Security, change, replacement, _chains(), _votes(policy, digest, P.ADMIN), proofs
        );
        T.CommitProposal memory consent = _executionCommit();
        account.commit(
            consent, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(consent)), P.ADMIN)
        );
        policy = replacement;
        assertEq(account.securityVersion(), 3);
        assertEq(_implementation(), address(revision));
        assertEq(V3UpgradeRevision(payable(address(account))).marker(), 42);
        assertEq(T.hashPolicy(account.securityPolicy()), T.hashPolicy(replacement));

        // Exit using only new authority and direct execution: no EntryPoint/bundler/paymaster call.
        T.Call[] memory calls = _calls(address(token), 0, abi.encodeCall(token.transfer, (recipient, 75)));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        vm.prank(recipient);
        account.executeSigned(calls, plan, votes);
        assertEq(token.balanceOf(address(account)), 0);
        assertEq(token.balanceOf(recipient), 100);
        assertEq(account.directNonce(), 1);
        assertEq(factory.getAddress(initial.initialSecurityCommitment, initial.userSaltCommitment), address(account));
    }

    function testFuzz_corruptingOrRevertingMigrationRollsBackImplementationAndCore(uint8 variant) external {
        _assertMigrationRollback(uint8(bound(variant, 0, 7)));
    }

    function test_migrationCannotChangeInitialSecurityCommitment() external {
        _assertMigrationRollback(0);
    }

    function test_migrationCannotChangeSecurityVersion() external {
        _assertMigrationRollback(1);
    }

    function test_migrationCannotChangeAdminNonce() external {
        _assertMigrationRollback(2);
    }

    function test_migrationCannotClearExecutionLock() external {
        _assertMigrationRollback(3);
    }

    function test_migrationCannotChangeAdminThreshold() external {
        _assertMigrationRollback(4);
    }

    function test_migrationCannotChangeUpgradeFreeze() external {
        _assertMigrationRollback(5);
    }

    function test_migrationCannotChangeImplementationSlot() external {
        _assertMigrationRollback(6);
    }

    function test_revertingMigrationRollsBackImplementationAndCore() external {
        _assertMigrationRollback(7);
    }

    function _assertMigrationRollback(uint8 variant) internal {
        assertLe(variant, 7);
        V3CorruptingUpgrade revision = new V3CorruptingUpgrade(address(ep));
        bytes memory migration = abi.encodeCall(revision.corrupt, (variant));
        _queue(_message(address(revision), migration));
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        bytes32 snapshot = _snapshot();
        vm.expectRevert(
            variant == 7
                ? V3CorruptingUpgrade.MigrationFailed.selector
                : Upgrade.AccountV3Upgrade__MigrationCorruptedCore.selector
        );
        account.commitUpgrade(commit, migration, votes);
        assertEq(_snapshot(), snapshot);
    }

    function test_migrationAuthorizationIsOneShotEvenForAnExactNestedCallback() external {
        V3UpgradeRevision revision = new V3UpgradeRevision(address(ep));
        V3UpgradeCallback callback = new V3UpgradeCallback();
        bytes memory migration = abi.encodeCall(revision.migrateAndCall, (address(callback)));
        callback.configure(migration);
        _queue(_message(address(revision), migration));
        vm.warp(START + 72 hours);
        _apply(migration);
        assertTrue(callback.rejected());
        assertEq(_implementation(), address(revision));
    }

    function test_nonemptyMigrationMustConsumeTheExplicitMigrationGate() external {
        bytes memory migration = abi.encodeCall(next.securityVersion, ());
        _queue(_message(address(next), migration));
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        bytes32 snapshot = _snapshot();
        vm.expectRevert(AccountV3.AccountV3__TypedUpgradeRequired.selector);
        account.commitUpgrade(commit, migration, votes);
        assertEq(_snapshot(), snapshot);
    }

    function test_adminCancelsAndOldProposalCannotReplay() external {
        bytes32 proposal = _queue(_message(address(next), ""));
        T.CancelProposal memory cancellation =
            T.CancelProposal(initial.accountId, 3, 1, proposal, 1, START, START + 5 minutes);
        account.cancel(
            cancellation,
            _votes(policy, T.digest(block.chainid, address(account), T.hashCancel(cancellation)), P.ADMIN)
        );
        (, uint8 kind) = account.proposal();
        assertEq(kind, uint8(D.ProposalKind.None));
        T.UpgradeManifest memory message = _message(address(next), "");
        message.nonce = 0;
        S.Signature[] memory votes = _upgradeVotes(message);
        vm.expectRevert(Security.AccountV3Security__WrongNonce.selector);
        account.proposeUpgrade(message, _chains(), votes);
        message.nonce = 2;
        assertNotEq(_queue(message), proposal);
    }

    function test_expiryReleasesPendingButNeverRestoresConsumedNonce() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        bytes32 proposal = _queue(message);
        vm.warp(message.validUntil);
        T.CommitProposal memory commit = _executionCommit();
        S.Signature[] memory votes = _commitVotes(commit);
        vm.expectRevert(Security.AccountV3Security__ProposalNotReady.selector);
        account.commitUpgrade(commit, "", votes);
        account.expire(proposal);
        (, uint256 nonce,,) = account.securityState();
        assertEq(nonce, 1);
        _queue(_message(address(next), ""));
    }

    function test_freezeCancelsQueuedUpgradeAndRotationDoesNotThawIt() external {
        _queue(_message(address(next), ""));
        T.FreezeUpgrades memory freeze = _executionFreeze();
        account.freeze(
            freeze, _chains(), _votes(policy, T.digest(block.chainid, address(account), T.hashFreeze(freeze)), P.ADMIN)
        );
        T.SecurityPolicy memory replacement = _policy(carol, dave);
        (T.SecurityChange memory change, bytes32 digest, S.Signature[] memory proofs) =
            _executionChange(replacement, E.ChangeKind.Security);
        account.prepare(
            E.ChangeKind.Security, change, replacement, _chains(), _votes(policy, digest, P.ADMIN), proofs
        );
        T.CommitProposal memory consent = _executionCommit();
        account.commit(
            consent, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(consent)), P.ADMIN)
        );
        policy = replacement;
        T.UpgradeManifest memory message = _message(address(next), "");
        S.Signature[] memory votes =
            _votes(replacement, T.digest(block.chainid, address(account), T.hashUpgrade(message)), P.ADMIN);
        vm.expectRevert(Upgrade.AccountV3Upgrade__Disabled.selector);
        account.proposeUpgrade(message, _chains(), votes);
    }

    function test_upgradeCallbackDuringSpendCannotConsumeValidAdminConsent() external {
        _queue(_message(address(next), ""));
        vm.warp(START + 72 hours);
        T.CommitProposal memory commit = _executionCommit();
        V3UpgradeCallback callback = new V3UpgradeCallback();
        callback.configure(abi.encodeCall(account.commitUpgrade, (commit, "", _commitVotes(commit))));
        T.Call[] memory calls = _calls(address(callback), 0, abi.encodeCall(callback.attempt, (address(account))));
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        assertTrue(callback.rejected());
        assertEq(_implementation(), address(implementation));
        _apply("");
        assertEq(_implementation(), address(next));
    }

    function test_fixedUpgradeLibraryCodeDriftFailsClosed() external {
        T.UpgradeManifest memory message = _message(address(next), "");
        S.Signature[] memory votes = _upgradeVotes(message);
        vm.etch(account.upgradeModule(), hex"00");
        vm.expectRevert(AccountV3.AccountV3__UpgradeModuleChanged.selector);
        account.proposeUpgrade(message, _chains(), votes);
    }

    function test_composedAccountAndFixedLibrariesKeepCodeHeadroom() external {
        assertLe(address(new AccountV3(address(ep))).code.length, 20_000);
        assertLe(account.securityModule().code.length, 20_000);
        assertLe(account.upgradeModule().code.length, 20_000);
        assertEq(account.storageLayoutHash(), D.LAYOUT_HASH);
    }

    function _message(address target, bytes memory migration) internal view returns (T.UpgradeManifest memory) {
        (bytes32 manifest, uint256 nonce,,) = account.securityState();
        return T.UpgradeManifest(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            target,
            target.codehash,
            D.LAYOUT_HASH,
            keccak256(abi.encode(_chains())),
            keccak256(migration),
            nonce,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 10 days)
        );
    }

    function _upgradeVotes(T.UpgradeManifest memory message) internal view returns (S.Signature[] memory) {
        return
            _votes(account.securityPolicy(), T.digest(block.chainid, address(account), T.hashUpgrade(message)), P.ADMIN);
    }

    function _commitVotes(T.CommitProposal memory message) internal view returns (S.Signature[] memory) {
        return
            _votes(account.securityPolicy(), T.digest(block.chainid, address(account), T.hashCommit(message)), P.ADMIN);
    }

    function _queue(T.UpgradeManifest memory message) internal returns (bytes32) {
        return account.proposeUpgrade(message, _chains(), _upgradeVotes(message));
    }

    function _apply(bytes memory migration) internal {
        T.CommitProposal memory message = _executionCommit();
        account.commitUpgrade(message, migration, _commitVotes(message));
    }

    function _implementation() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(account), ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _snapshot() internal view returns (bytes32) {
        (bytes32 manifest, uint256 admin,, bool frozen) = account.securityState();
        (bytes32 proposal, uint8 kind) = account.proposal();
        (uint32 generation, bytes32 id, bytes32 initialCommitment, bytes32 salt) = account.creationIdentity();
        return keccak256(
            abi.encode(
                _implementation(),
                manifest,
                admin,
                frozen,
                proposal,
                kind,
                account.securityVersion(),
                account.directNonce(),
                account.executing(),
                generation,
                id,
                initialCommitment,
                salt,
                T.hashPolicy(account.securityPolicy()),
                address(account).balance
            )
        );
    }
}
