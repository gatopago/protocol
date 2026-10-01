// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Initialization as Initialization} from "src/v3/AccountV3Initialization.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Candidate stateful security transitions. Fixed linked library, NOT an Account/factory/upgrade executor.
/// @dev Initialization must establish this namespace using verified factory/identity/possession proofs.
/// Authority is always loaded from storage. External verifiers only receive bounded STATICCALLs, before writes.
/// Future asset execution must set Layout.executing for its entire call batch and use its own reentrancy guard.
/// TimelockController schedules arbitrary calls under address roles; it cannot represent this typed,
/// per-account administrative policy protocol. This library never CALLs assets, DELEGATECALLs or writes ERC-1967.
/// Its public entrypoints run by compiler-generated DELEGATECALL in the account context. The account
/// MUST pin/check this library's code and link address; there is no caller-selected module or dispatch.
/// OZ Nonces/NoncesKeyed own address-keyed storage; V3 uses protocol-fixed uint256 purpose counters and
/// bytes32 signer IDs in its ERC-7201 namespace. These counters are checked and never reset or narrowed.
library AccountV3Security {
    event PolicyProposed(
        bytes32 indexed proposalHash,
        D.ProposalKind kind,
        uint64 securityVersion,
        bytes32 nextPolicyHash,
        bytes32 chainScopeHash,
        uint48 readyAt,
        uint48 validUntil
    );
    event PolicyInstalled(bytes32 indexed proposalHash, bytes32 indexed manifestHash, uint64 securityVersion);
    event ProposalCommitted(bytes32 indexed proposalHash, bytes32 acknowledgementsHash);
    event ProposalCancelled(bytes32 indexed proposalHash, bytes32 indexed authorizationHash);
    event ProposalExpired(bytes32 indexed proposalHash);
    event UpgradesFrozen(bytes32 indexed authorizationHash, bytes32 cancelledUpgrade);

    error AccountV3Security__Uninitialized();
    error AccountV3Security__Executing();
    error AccountV3Security__CreationPending();
    error AccountV3Security__WrongAccount();
    error AccountV3Security__StaleVersion();
    error AccountV3Security__WrongPredecessor();
    error AccountV3Security__OutsideValidity();
    error AccountV3Security__InvalidProposalLifetime();
    error AccountV3Security__WrongScope();
    error AccountV3Security__WrongPolicy();
    error AccountV3Security__WrongMode();
    error AccountV3Security__PendingProposal();
    error AccountV3Security__WrongNonce();
    error AccountV3Security__InvalidConsent();
    error AccountV3Security__TimelockExceedsValidity();
    error AccountV3Security__WrongProposal();
    error AccountV3Security__ProposalNotReady();
    error AccountV3Security__MissingAcknowledgements();
    error AccountV3Security__AlreadyFrozen();
    error AccountV3Security__NotExpired();
    error AccountV3Security__SpendingDisabled();

    /*//////////////////////////////////////////////////////////////
                      LINKED STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Only reached from the pinned account's one-time initialize() after proxy
    /// validation and the library codehash guard. Not exposed by AccountV3SecurityModule.
    /// Compiler library guard rejects a direct CALL; initialization proofs are still checked
    /// in the proxy domain, and dirty state is rejected before any installation.
    function installInitialPolicy(
        T.InitializationApproval calldata message,
        T.SecurityPolicy memory policy,
        uint256[] calldata chains,
        S.Signature[] calldata proofs,
        address entryPoint
    ) public {
        Initialization.validateIdentity(message, policy, msg.sender, entryPoint);
        Initialization.install(message, policy, chains, proofs);
    }

    function prepare(
        E.ChangeKind kind,
        T.SecurityChange memory change,
        T.SecurityPolicy memory next,
        uint256[] calldata chains,
        S.Signature[] memory authorizations,
        S.Signature[] memory enrollments
    ) public returns (bytes32 proposalHash) {
        D.Layout storage state = _state();
        _checkMessage(
            state, change.accountId, change.generation, change.securityVersion, change.validAfter, change.validUntil
        );
        _predecessor(state, change.previousManifestHash);
        _scope(change.chainScopeHash, chains);
        P.validate(next);
        T.SecurityPolicy memory current = PS.load(state.policy);
        if (
            next.mode != P.ACTIVE || T.hashPolicy(next) != change.nextPolicyHash
                || change.nextPolicyHash == T.hashPolicy(current)
        ) revert AccountV3Security__WrongPolicy();

        _checkConsentWindow(change.validAfter, change.validUntil);
        // The short acceptance consent must not cover the whole finality/timelock wait.
        // Both deadlines are signed. Bound lifetime from validAfter (not delivery time)
        // so relayers cannot prolong it by delaying acceptance.
        if (
            change.proposalValidUntil <= change.validUntil
                || uint256(change.proposalValidUntil) > uint256(change.validAfter) + T.MAX_PROPOSAL_COMPLETION
        ) revert AccountV3Security__InvalidProposalLifetime();
        if (state.policy.mode != P.ACTIVE) revert AccountV3Security__WrongMode();
        D.ProposalKind pendingKind = state.pending.kind;
        if (pendingKind != D.ProposalKind.None) {
            revert AccountV3Security__PendingProposal();
        }
        _nonce(change.nonce, state.adminNonce);
        // Administrative policy proposals are ready at acceptance; upgrades keep a separate timelock.
        uint48 readyAt = _now();
        if (readyAt >= change.proposalValidUntil) revert AccountV3Security__TimelockExceedsValidity();
        if (!E.verifyChange(current, next, kind, change, authorizations, enrollments)) {
            revert AccountV3Security__InvalidConsent();
        }
        proposalHash = _digest(E.hashChange(kind, change));
        ++state.adminNonce;
        // Clear nested dynamic arrays and any old upgrade payload before installing a replacement.
        delete state.pending;
        D.PendingProposal storage pending = state.pending;
        pending.kind = D.ProposalKind.Security;
        pending.securityVersion = state.securityVersion;
        pending.previousManifestHash = state.manifestHash;
        pending.proposalHash = proposalHash;
        pending.chainScopeHash = change.chainScopeHash;
        pending.readyAt = readyAt;
        pending.validUntil = change.proposalValidUntil;
        _writePolicy(pending.nextPolicy, next);
        emit PolicyProposed(
            proposalHash,
            pending.kind,
            state.securityVersion,
            change.nextPolicyHash,
            change.chainScopeHash,
            readyAt,
            change.proposalValidUntil
        );
    }

    /// @dev Fresh authority from the OLD policy commits Security changes only. No upgrade shortcut.
    /// acknowledgementsHash is the signers' commitment, NOT proof of another chain's finality.
    function commitPolicy(T.CommitProposal memory message, S.Signature[] memory authorizations) public {
        D.Layout storage state = _state();
        _checkMessage(
            state,
            message.accountId,
            message.generation,
            message.securityVersion,
            message.validAfter,
            message.validUntil
        );
        _predecessor(state, message.previousManifestHash);
        D.PendingProposal storage pending = state.pending;
        if (pending.kind != D.ProposalKind.Security) revert AccountV3Security__WrongProposal();
        _pending(state, message.proposalHash);
        if (pending.chainScopeHash != message.chainScopeHash) revert AccountV3Security__WrongScope();
        _ready(pending);
        _checkConsentWindow(message.validAfter, message.validUntil);
        if (message.validUntil > pending.validUntil) revert AccountV3Security__OutsideValidity();
        if (message.acknowledgementsHash == bytes32(0)) revert AccountV3Security__MissingAcknowledgements();
        _nonce(message.nonce, state.adminNonce);
        bytes32 digest = _digest(T.hashCommit(message));
        T.SecurityPolicy memory current = PS.load(state.policy);
        bool authorized = S.verifyQuorum(current, P.ADMIN, digest, authorizations);
        if (!authorized) revert AccountV3Security__InvalidConsent();
        ++state.adminNonce;
        _install(state);
        emit ProposalCommitted(message.proposalHash, message.acknowledgementsHash);
    }

    /// @notice Cancel one exact proposal using current ADMIN authority, never a generic signer veto.
    /// @dev Consumer ADMIN=1 intentionally lets any current consumer owner cancel. This is not
    /// protection against a compromised administrator. Cancellation never rewinds a nonce/version.
    function cancel(T.CancelProposal memory message, S.Signature[] memory signatures) public {
        D.Layout storage state = _state();
        _checkMessage(
            state,
            message.accountId,
            message.generation,
            message.securityVersion,
            message.validAfter,
            message.validUntil
        );
        _pending(state, message.proposalHash);
        _checkConsentWindow(message.validAfter, message.validUntil);
        _nonce(message.nonce, state.adminNonce);
        bytes32 digest = _digest(T.hashCancel(message));
        if (!S.verifyQuorum(PS.load(state.policy), P.ADMIN, digest, signatures)) {
            revert AccountV3Security__InvalidConsent();
        }
        ++state.adminNonce;
        delete state.pending;
        emit ProposalCancelled(message.proposalHash, digest);
    }

    /// @dev Irreversible; does not alter signers or increment the manifest version.
    function freezeUpgrades(
        T.FreezeUpgrades memory message,
        uint256[] calldata chains,
        S.Signature[] memory authorizations
    ) public {
        D.Layout storage state = _state();
        _checkMessage(
            state,
            message.accountId,
            message.generation,
            message.securityVersion,
            message.validAfter,
            message.validUntil
        );
        _predecessor(state, message.previousManifestHash);
        _scope(message.chainScopeHash, chains);
        if (state.policy.mode != P.ACTIVE) revert AccountV3Security__WrongMode();
        if (state.upgradesFrozen) revert AccountV3Security__AlreadyFrozen();
        _nonce(message.nonce, state.adminNonce);
        bytes32 digest = _digest(T.hashFreeze(message));
        if (!S.verifyQuorum(PS.load(state.policy), P.ADMIN, digest, authorizations)) {
            revert AccountV3Security__InvalidConsent();
        }
        ++state.adminNonce;
        state.upgradesFrozen = true;
        bytes32 cancelled;
        if (state.pending.kind == D.ProposalKind.Upgrade) {
            cancelled = state.pending.proposalHash;
            delete state.pending;
        }
        emit UpgradesFrozen(digest, cancelled);
    }

    function expire(bytes32 proposalHash) public {
        D.Layout storage state = _state();
        _pending(state, proposalHash);
        if (_now() < state.pending.validUntil) revert AccountV3Security__NotExpired();
        delete state.pending;
        emit ProposalExpired(proposalHash);
    }

    /// @notice Read the canonical signed policy without exposing its compact storage format.
    /// @dev Read-only even while creation is pending; never constitutes spend approval.
    function readPolicy() public view returns (T.SecurityPolicy memory) {
        D.Layout storage state = D.layout();
        if (!state.initialized || state.generation != T.GENERATION) {
            revert AccountV3Security__Uninitialized();
        }
        return PS.load(state.policy);
    }

    /// @dev Predicate only. The executor binds the plan, mode, nonce, CALLs and validity separately.
    /// Reuses the already linked policy/signature implementation instead of embedding it twice.
    /// Bootstrap may authorize only authenticated creation while its window is pending, never spend.
    function verifyExecutionSignature(bytes32 digest, bool creation, S.Signature[] memory signatures)
        public
        view
        returns (bool)
    {
        D.Layout storage state = D.layout();
        if (!state.initialized || state.generation != T.GENERATION || state.executing) return false;
        T.SecurityPolicy memory current = PS.load(state.policy);
        // Creation-window consumption is enforced by EntryPoint/Validity. A creation-only
        // operation is never reusable after that window has been consumed.
        if (creation && state.creationValidUntil == 0) return false;
        return S.verifyValidatedQuorum(current, P.SPEND, digest, signatures);
    }

    /// @notice ERC-1271 predicate in the account's storage/domain; never consumes a nonce or emits events.
    /// @dev The caller checks the fixed library codehash. Validation remains available during CALLs:
    /// an application may need to check an order/permit while executing; security mutation is locked.
    /// No TIMESTAMP here. The application hash MUST bind its domain, nonce and deadline as needed.
    /// Malformed ABI may revert; callers MUST treat reverts as invalid (e.g. OZ SignatureChecker).
    function verifyAccountSignature(bytes32 applicationHash, bytes memory envelope) public view returns (bool) {
        // Canonical header + at most 16 signatures of 4096 bytes. Check before nested ABI decoding.
        if (envelope.length < 192 || envelope.length > 67_776) return false;
        (T.AccountSignature memory message, S.Signature[] memory signatures) =
            abi.decode(envelope, (T.AccountSignature, S.Signature[]));
        D.Layout storage state = D.layout();
        if (
            !state.initialized || state.generation != T.GENERATION || state.creationValidUntil != 0
                || state.policy.mode != P.ACTIVE || message.accountId != D.accountId(state)
                || message.generation != T.GENERATION || message.securityVersion != state.securityVersion
                || message.applicationHash != applicationHash
                || keccak256(envelope) != keccak256(abi.encode(message, signatures))
        ) return false;
        return S.verifyValidatedQuorum(
            PS.load(state.policy),
            P.SPEND,
            T.digest(block.chainid, address(this), T.hashAccountSignature(message)),
            signatures
        );
    }

    function _install(D.Layout storage state) private {
        D.PendingProposal storage pending = state.pending;
        uint64 nextVersion = SafeCast.toUint64(uint256(state.securityVersion) + 1);
        T.SecurityPolicy memory next = pending.nextPolicy;
        bytes32 proposalHash = pending.proposalHash;
        bytes32 nextScope = pending.chainScopeHash;
        bytes32 manifestHash = T.hashManifest(
            T.SecurityManifest({
                accountId: D.accountId(state),
                generation: state.generation,
                securityVersion: nextVersion,
                previousManifestHash: state.manifestHash,
                policyHash: T.hashPolicy(next),
                chainScopeHash: nextScope
            })
        );
        PS.store(state.policy, next);
        state.securityVersion = nextVersion;
        state.manifestHash = manifestHash;
        state.chainScopeHash = nextScope;
        delete state.pending;
        emit PolicyInstalled(proposalHash, manifestHash, nextVersion);
    }

    function _writePolicy(T.SecurityPolicy storage target, T.SecurityPolicy memory source) private {
        delete target.signers;
        for (uint256 i; i < source.signers.length; ++i) {
            target.signers.push(source.signers[i]);
        }
        target.mode = source.mode;
        target.spendThreshold = source.spendThreshold;
        target.adminThreshold = source.adminThreshold;
        target.upgradeDelaySeconds = source.upgradeDelaySeconds;
    }

    /*//////////////////////////////////////////////////////////////
                      INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Necessary guard, NOT spend authorization. The executor still needs signatures/nonces/limits.
    /// An expired proposal never installs a policy; expire only clears its pending record.
    function requireSpendEnabled() internal view {
        D.Layout storage state = _state();
        if (state.policy.mode != P.ACTIVE) {
            revert AccountV3Security__SpendingDisabled();
        }
    }

    function _state() internal view returns (D.Layout storage state) {
        state = D.layout();
        if (
            !state.initialized || state.generation != T.GENERATION || state.securityVersion == 0
                || state.initialSecurityCommitment == bytes32(0)
        ) {
            revert AccountV3Security__Uninitialized();
        }
        if (state.executing) revert AccountV3Security__Executing();
        if (state.creationValidUntil != 0) revert AccountV3Security__CreationPending();
    }

    function _checkMessage(
        D.Layout storage state,
        bytes32 id,
        uint32 generation,
        uint64 version,
        uint48 after_,
        uint48 until
    ) internal view {
        uint48 now_ = _now();
        if (until <= after_ || now_ < after_ || now_ >= until) revert AccountV3Security__OutsideValidity();
        if (id != D.accountId(state) || generation != state.generation) revert AccountV3Security__WrongAccount();
        if (version != state.securityVersion) revert AccountV3Security__StaleVersion();
    }

    function _predecessor(D.Layout storage state, bytes32 previousManifestHash) internal view {
        if (previousManifestHash != state.manifestHash) revert AccountV3Security__WrongPredecessor();
    }

    /// @dev Called after _checkMessage; uint48 bounds make the widened addition overflow-free.
    function _checkConsentWindow(uint48 after_, uint48 until) private pure {
        if (after_ == 0 || uint256(until) > uint256(after_) + T.MAX_CONSENT_WINDOW) {
            revert AccountV3Security__OutsideValidity();
        }
    }

    function _pending(D.Layout storage state, bytes32 proposalHash) internal view {
        D.PendingProposal storage pending = state.pending;
        if (pending.kind == D.ProposalKind.None || proposalHash != pending.proposalHash) {
            revert AccountV3Security__WrongProposal();
        }
        if (pending.securityVersion != state.securityVersion) revert AccountV3Security__StaleVersion();
        _predecessor(state, pending.previousManifestHash);
    }

    function _ready(D.PendingProposal storage pending) internal view {
        uint48 now_ = _now();
        if (now_ < pending.readyAt || now_ >= pending.validUntil) revert AccountV3Security__ProposalNotReady();
    }

    function _scope(bytes32 expected, uint256[] calldata chains) internal view {
        if (chains.length == 0 || chains.length > 32) revert AccountV3Security__WrongScope();
        bool included;
        for (uint256 i; i < chains.length; ++i) {
            if (chains[i] == 0 || (i != 0 && chains[i] <= chains[i - 1])) revert AccountV3Security__WrongScope();
            if (chains[i] == block.chainid) included = true;
        }
        if (!included || keccak256(abi.encode(chains)) != expected) revert AccountV3Security__WrongScope();
    }

    function _nonce(uint256 supplied, uint256 current) internal pure {
        if (supplied != current || current == type(uint256).max) revert AccountV3Security__WrongNonce();
    }

    function _now() internal view returns (uint48) {
        // Signed validity/timelock checks, never entropy; no narrowing wraparound.
        // forge-lint: disable-next-line(block-timestamp)
        return SafeCast.toUint48(block.timestamp);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return T.digest(block.chainid, address(this), structHash);
    }
}
