// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";

/// @notice Initial-policy validation and possession, separate from a UserOperation signature.
/// @dev The caller must enforce one-time initialization, validateIdentity for the exact policy,
/// and authenticate its proxy/factory context before install. The only production caller is the
/// fixed Security installer reached through AccountV3Initializable's guarded initialize().
library AccountV3Initialization {
    error AccountV3Initialization__WrongIdentity();
    error AccountV3Initialization__WrongDeployment();
    error AccountV3Initialization__OutsideValidity();
    error AccountV3Initialization__WrongScope();
    error AccountV3Initialization__MissingPossession();
    error AccountV3Initialization__DirtyState();

    function install(
        T.InitializationApproval calldata message,
        T.SecurityPolicy memory policy,
        uint256[] calldata chains,
        S.Signature[] calldata proofs
    ) internal {
        D.Layout storage state = D.layout();
        if (state.initialized || state.generation != 0 || state.initialSecurityCommitment != bytes32(0)) {
            revert AccountV3Initialization__DirtyState();
        }
        // No TIMESTAMP in the factory/validation frame. The EntryPoint checks this signed window.
        if (
            message.validAfter == 0 || message.validUntil <= message.validAfter
                || message.validUntil > Validity.MAX_TIMESTAMP
        ) {
            revert AccountV3Initialization__OutsideValidity();
        }
        if (chains.length == 0 || chains.length > 32) revert AccountV3Initialization__WrongScope();
        bool included;
        for (uint256 i; i < chains.length; ++i) {
            if (chains[i] == 0 || (i != 0 && chains[i] <= chains[i - 1])) revert AccountV3Initialization__WrongScope();
            if (chains[i] == block.chainid) included = true;
        }
        if (!included || keccak256(abi.encode(chains)) != message.chainScopeHash) {
            revert AccountV3Initialization__WrongScope();
        }
        // EVERY initial signer proves possession, not merely the spend/admin threshold.
        if (proofs.length != policy.signers.length) revert AccountV3Initialization__MissingPossession();
        bytes32 digest = T.digest(block.chainid, address(this), T.hashInitialization(message));
        uint256 seen;
        for (uint256 i; i < proofs.length; ++i) {
            uint256 index = proofs[i].signerIndex;
            uint256 mask = uint256(1) << index;
            if (index >= policy.signers.length || (seen & mask) != 0) {
                revert AccountV3Initialization__MissingPossession();
            }
            seen |= mask;
            if (!S.verifyValidatedSigner(policy.signers[index], digest, proofs[i].signature)) {
                revert AccountV3Initialization__MissingPossession();
            }
        }

        // All external verification is bounded STATICCALL. Nothing is usable until every proof passes.
        Validity.recordCreation(message.validAfter, message.validUntil);
        state.generation = T.GENERATION;
        state.securityVersion = 1;
        state.initialSecurityCommitment = message.initialSecurityCommitment;
        state.userSaltCommitment = message.userSaltCommitment;
        state.chainScopeHash = message.chainScopeHash;
        state.manifestHash = T.hashManifest(
            T.SecurityManifest(
                message.accountId,
                T.GENERATION,
                1,
                bytes32(0),
                message.initialSecurityCommitment,
                message.chainScopeHash
            )
        );
        // The fixed installer validated this exact policy before checking every possession proof.
        PS.storeValidated(state.policy, policy);
        state.initialized = true;
    }

    function validateIdentity(
        T.InitializationApproval calldata message,
        T.SecurityPolicy memory policy,
        address factory,
        address entryPoint
    ) internal pure {
        if (
            message.factory != factory || factory == address(0) || message.entryPoint != entryPoint
                || entryPoint == address(0)
        ) {
            revert AccountV3Initialization__WrongDeployment();
        }
        P.validate(policy);
        if (
            message.generation != T.GENERATION || message.nonce != 0
                || message.initialSecurityCommitment != T.hashPolicy(policy)
                || message.accountId != T.accountId(message.initialSecurityCommitment, message.userSaltCommitment)
        ) {
            revert AccountV3Initialization__WrongIdentity();
        }
    }
}
