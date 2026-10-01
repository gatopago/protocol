// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {LowLevelCall} from "@openzeppelin/contracts/utils/LowLevelCall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AccountV3EntryPoint} from "src/v3/AccountV3EntryPoint.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";

/// @notice Signed atomic CALL execution for the V3 account composition. Not the final UUPS/ERC-1271 account.
/// @dev Mode 0 uses EntryPoint nonces and the actual UserOp hash. Mode 1 is a public, signed direct
/// relay with an independent account nonce: it needs neither a bundler nor a GatoPago service.
/// Generic CALL success is NOT proof of payment settlement (e.g. an ERC-20 can return false).
/// Asset/fee/preview hashes are signed commitments, not an interpreter of arbitrary token semantics.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
abstract contract AccountV3Execution is AccountV3EntryPoint, ReentrancyGuardTransient {
    uint8 public constant EXECUTION_USEROP = 0;
    uint8 public constant EXECUTION_DIRECT = 1;
    uint256 public constant MAX_CALLS = 32;

    event CallsExecuted(bytes32 indexed callsHash, uint64 securityVersion, uint8 executionMode);
    event DirectAuthorizationConsumed(bytes32 indexed digest, uint256 indexed nonce);
    event CreationCompleted();

    error AccountV3Execution__InvalidPlan();
    error AccountV3Execution__InvalidCalls();
    error AccountV3Execution__InvalidSignature();
    error AccountV3Execution__CallFailed(uint256 index, address target);
    error AccountV3Execution__OutsideValidity();

    constructor(address ep) AccountV3EntryPoint(ep) {}

    /// @dev EntryPoint is the ONLY implicit executor. Self-CALL is deliberately not an authority.
    /// Recheck security at execution: another operation may change it after the validation loop.
    function execute(T.Call[] calldata calls, uint64 expectedSecurityVersion) external nonReentrant onlyEntryPoint {
        _checkSecurityModule();
        Security.requireSpendEnabled();
        if (D.layout().securityVersion != expectedSecurityVersion) revert AccountV3Execution__InvalidPlan();
        _checkCalls(calls);
        _execute(calls, expectedSecurityVersion, EXECUTION_USEROP);
    }

    /// @notice Relays an exact signed batch; msg.sender gains no account authority or reimbursement.
    /// @dev Caller funds transaction gas. A failed batch rolls back its direct nonce and every CALL.
    function executeSigned(T.Call[] calldata calls, T.ExecutionPlan calldata plan, S.Signature[] calldata signatures)
        external
        nonReentrant
    {
        _checkSecurityModule();
        Security.requireSpendEnabled();
        D.Layout storage state = D.layout();
        _checkIdentity(plan, state);
        if (
            plan.executionMode != EXECUTION_DIRECT || plan.entryPoint != address(0) || plan.userOpHash != bytes32(0)
                || plan.paymaster != address(0) || plan.nonce != state.spendNonce
                || plan.callsHash != keccak256(abi.encode(calls))
        ) revert AccountV3Execution__InvalidPlan();
        _checkCalls(calls);
        Validity.validationData(true, plan.validAfter, plan.validUntil);
        // Signed half-open expiry uses consensus time, not randomness. Only the direct execution
        // path reads TIMESTAMP; ERC-4337 validation returns its window to EntryPoint instead.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < plan.validAfter || block.timestamp >= plan.validUntil) {
            revert AccountV3Execution__OutsideValidity();
        }
        bytes32 digest = T.digest(block.chainid, address(this), T.hashExecution(plan));
        if (!Security.verifyExecutionSignature(digest, false, signatures)) {
            revert AccountV3Execution__InvalidSignature();
        }
        ++state.spendNonce;
        emit DirectAuthorizationConsumed(digest, plan.nonce);
        _execute(calls, plan.securityVersion, EXECUTION_DIRECT);
    }

    /// @notice A pending account may finish authenticated creation, never execute asset calls.
    /// @dev Validation accepts this selector only while creation is pending. No generic callback.
    function completeCreation() external onlyEntryPoint {
        emit CreationCompleted();
    }

    function directNonce() external view returns (uint256) {
        return D.layout().spendNonce;
    }

    function securityVersion() external view returns (uint64) {
        return D.layout().securityVersion;
    }

    function _execute(T.Call[] calldata calls, uint64 version, uint8 mode) private {
        D.Layout storage state = D.layout();
        // Also locks the fixed security module, including callbacks with otherwise valid admin proofs.
        state.executing = true;
        for (uint256 i; i < calls.length; ++i) {
            // OZ's bounded-return primitive supports native EOAs and arbitrary contract calldata.
            // Never copy attacker-sized return/revert data and never delegate to a caller target.
            if (!LowLevelCall.callNoReturn(calls[i].target, calls[i].value, calls[i].data)) {
                revert AccountV3Execution__CallFailed(i, calls[i].target);
            }
        }
        state.executing = false;
        emit CallsExecuted(keccak256(abi.encode(calls)), version, mode);
    }

    function _validateAccountUserOp(PackedUserOperation calldata op, bytes32 opHash, bytes calldata signature)
        internal
        view
        override
        returns (uint256)
    {
        (T.ExecutionPlan memory plan, S.Signature[] memory signatures) =
            abi.decode(signature, (T.ExecutionPlan, S.Signature[]));
        D.Layout storage state = D.layout();
        _checkIdentity(plan, state);
        if (
            state.executing || plan.executionMode != EXECUTION_USEROP || plan.entryPoint != address(entryPoint())
                || plan.userOpHash != opHash || plan.nonce != op.nonce || plan.paymaster != ERC4337Utils.paymaster(op)
                || op.nonce >> 64 != 0 || op.callData.length < 4
        ) revert AccountV3Execution__InvalidPlan();
        bool creating = bytes4(op.callData[:4]) == this.completeCreation.selector;
        if (creating) {
            // Domain-specific no-op commitment, not the hash of an empty payment batch.
            if (state.creationValidUntil == 0 || op.callData.length != 4 || plan.callsHash != keccak256(op.callData)) {
                revert AccountV3Execution__InvalidPlan();
            }
        } else {
            if (bytes4(op.callData[:4]) != this.execute.selector) revert AccountV3Execution__InvalidPlan();
            if (state.policy.mode != P.ACTIVE) {
                revert Security.AccountV3Security__SpendingDisabled();
            }
            (T.Call[] memory calls, uint64 version) = abi.decode(op.callData[4:], (T.Call[], uint64));
            _checkCalls(calls);
            if (
                version != plan.securityVersion || plan.callsHash != keccak256(abi.encode(calls))
                    || keccak256(op.callData) != keccak256(abi.encodeCall(this.execute, (calls, version)))
            ) revert AccountV3Execution__InvalidPlan();
        }
        bytes32 digest = T.digest(block.chainid, address(this), T.hashExecution(plan));
        bool authorized = Security.verifyExecutionSignature(digest, creating, signatures);
        return Validity.validationData(authorized, plan.validAfter, plan.validUntil);
    }

    function _checkIdentity(T.ExecutionPlan memory plan, D.Layout storage state) private view {
        if (
            !state.initialized || state.generation != T.GENERATION || plan.accountId != D.accountId(state)
                || plan.generation != T.GENERATION || plan.securityVersion != state.securityVersion
        ) revert AccountV3Execution__InvalidPlan();
    }

    function _checkCalls(T.Call[] memory calls) private view {
        if (calls.length == 0 || calls.length > MAX_CALLS) revert AccountV3Execution__InvalidCalls();
        for (uint256 i; i < calls.length; ++i) {
            // Security changes/upgrades are separate typed operations, never nested in a spend batch.
            if (calls[i].target == address(0) || calls[i].target == address(this)) {
                revert AccountV3Execution__InvalidCalls();
            }
        }
    }
}
