// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";

/// @notice Cryptographic consent for a policy proposal, including every new/changed member's possession proof.
/// @dev No state transition. The account MUST load previous policy from storage, compare accountId/version/
/// predecessor/nonce/scope with its state, consume the appropriate nonce and apply timelock/commit/cancellation rules.
/// Internal address(this)/block.chainid prevent callers from substituting the EIP-712 domain.
library AccountV3Enrollment {
    enum ChangeKind {
        Security
    }

    function verifyChange(
        T.SecurityPolicy memory previous,
        T.SecurityPolicy memory next,
        ChangeKind kind,
        T.SecurityChange memory change,
        S.Signature[] memory authorizations,
        S.Signature[] memory enrollments
    ) internal view returns (bool) {
        P.validate(previous);
        P.validate(next);
        if (
            next.mode != P.ACTIVE || change.generation != T.GENERATION || change.accountId == bytes32(0)
                || change.securityVersion == 0 || change.previousManifestHash == bytes32(0)
                || change.chainScopeHash == bytes32(0) || change.nextPolicyHash != T.hashPolicy(next)
        ) return false;
        // Signed, half-open validity window, not randomness. Small consensus timestamp skew remains possible;
        // the account's separate upgrade timelock must start when the proposal is accepted.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < change.validAfter || block.timestamp >= change.validUntil) return false;
        bytes32 contextHash = T.digest(block.chainid, address(this), hashChange(kind, change));
        if (!S.verifyQuorum(previous, P.ADMIN, contextHash, authorizations)) {
            return false;
        }

        uint256 required;
        for (uint256 i; i < next.signers.length; ++i) {
            T.SignerDescriptor memory member = next.signers[i];
            bool unchanged;
            bytes32 id = T.signerId(member);
            for (uint256 j; j < previous.signers.length; ++j) {
                T.SignerDescriptor memory old = previous.signers[j];
                if (id == T.signerId(old) && member.roles == old.roles) {
                    unchanged = true;
                    break;
                }
            }
            if (!unchanged) required |= uint256(1) << i;
        }
        if (enrollments.length > next.signers.length) return false;
        uint256 seen;
        for (uint256 i; i < enrollments.length; ++i) {
            uint256 index = enrollments[i].signerIndex;
            if (index >= next.signers.length) return false;
            uint256 mask = uint256(1) << index;
            if ((required & mask) == 0 || (seen & mask) != 0) return false;
            seen |= mask;
            T.SignerDescriptor memory member = next.signers[index];
            T.EnrollmentProof memory proof = T.EnrollmentProof({
                accountId: change.accountId,
                generation: change.generation,
                securityVersion: change.securityVersion,
                signerId: T.signerId(member),
                nextPolicyHash: change.nextPolicyHash,
                contextHash: contextHash,
                nonce: change.nonce,
                validAfter: change.validAfter,
                validUntil: change.validUntil
            });
            if (!S.verifySigner(
                    member, T.digest(block.chainid, address(this), T.hashEnrollment(proof)), enrollments[i].signature
                )) {
                return false;
            }
        }
        return seen == required;
    }

    /// @dev One encoding shared by verification and persistence. The selected typehash
    /// has a single SecurityChange purpose; retired recovery/activation payloads are not admitted.
    function hashChange(ChangeKind, T.SecurityChange memory change) internal pure returns (bytes32) {
        return T.hashSecurity(change);
    }
}
