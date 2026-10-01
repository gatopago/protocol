// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as Policy} from "src/v3/AccountV3Policy.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC7913SignatureVerifier} from "@openzeppelin/contracts/interfaces/IERC7913.sol";

/// @notice Signature/quorum predicates. No storage, nonce consumption, enrollment or account execution.
/// @dev The future account MUST bind digest to its typed authorization and check state/version/time/nonces.
library AccountV3Signatures {
    // Candidate V3 resource profile, not universal ERC-1271 compatibility. Measured before chain promotion.
    uint256 internal constant VERIFIER_GAS_LIMIT = 1_000_000;
    uint256 internal constant MAX_SIGNATURE_BYTES = 4096;

    struct Signature {
        uint8 signerIndex;
        bytes signature;
    }

    /// @notice Malformed policies revert. A missing/invalid signature or wrong authority returns false.
    /// @dev Only active policies with reachable SPEND and ADMIN authority are accepted.
    function verifyQuorum(T.SecurityPolicy memory policy, uint8 role, bytes32 digest, Signature[] memory signatures)
        internal
        view
        returns (bool)
    {
        Policy.validate(policy);
        return verifyValidatedQuorum(policy, role, digest, signatures);
    }

    /// @dev For a policy already validated at installation, loaded exclusively from the guarded
    /// V3 namespace. Threshold, membership, roles, duplicate votes and signatures are STILL checked.
    /// Untrusted policies must use verifyQuorum, which validates their complete structure first.
    function verifyValidatedQuorum(
        T.SecurityPolicy memory policy,
        uint8 role,
        bytes32 digest,
        Signature[] memory signatures
    ) internal view returns (bool) {
        if (policy.mode != Policy.ACTIVE) return false;
        uint256 threshold;
        if (role == Policy.SPEND) threshold = policy.spendThreshold;
        else if (role == Policy.ADMIN) threshold = policy.adminThreshold;
        else return false;
        if (threshold == 0 || signatures.length < threshold || signatures.length > policy.signers.length) return false;
        uint256 seen;
        for (uint256 i; i < signatures.length; ++i) {
            uint256 index = signatures[i].signerIndex;
            if (index >= policy.signers.length) return false;
            uint256 mask = uint256(1) << index;
            if ((seen & mask) != 0) return false;
            seen |= mask;
            T.SignerDescriptor memory signer = policy.signers[index];
            if ((signer.roles & role) == 0 || !verifyValidatedSigner(signer, digest, signatures[i].signature)) {
                return false;
            }
        }
        return true;
    }

    /// @dev Primitive for enrollment after the account has selected the expected descriptor and digest.
    function verifySigner(T.SignerDescriptor memory signer, bytes32 digest, bytes memory signature)
        internal
        view
        returns (bool)
    {
        Policy.validateSigner(signer);
        return verifyValidatedSigner(signer, digest, signature);
    }

    /// @dev Only after validating this exact descriptor/policy. No external entrypoint or storage trust.
    /// Initialization already validates every descriptor in validateIdentity before STATICCALL proofs.
    function verifyValidatedSigner(T.SignerDescriptor memory signer, bytes32 digest, bytes memory signature)
        internal
        view
        returns (bool)
    {
        if (signature.length > MAX_SIGNATURE_BYTES) return false;
        if (signer.kind == Policy.ECDSA) {
            // Explicit direct-key profile, even if this address later has code (e.g. EIP-7702).
            // Never silently switch to ERC-1271 based on extcodesize.
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && recovered == address(bytes20(signer.key));
        }
        address verifier = signer.verifier;
        if (verifier.code.length == 0 || verifier.codehash != signer.verifierCodeHash) return false;
        if (signer.kind == Policy.ERC1271) {
            return _staticVerify(
                verifier,
                abi.encodeCall(IERC1271.isValidSignature, (digest, signature)),
                IERC1271.isValidSignature.selector
            );
        }
        return _staticVerify(
            verifier,
            abi.encodeCall(IERC7913SignatureVerifier.verify, (signer.key, digest, signature)),
            IERC7913SignatureVerifier.verify.selector
        );
    }

    /// @dev OZ SignatureChecker has no per-verifier gas budget; its 7913 overload copies unbounded returndata.
    /// This transport adds those bounds; cryptography remains in OZ/pinned verifiers. No return data bubbling.
    function _staticVerify(address target, bytes memory input, bytes4 magic) private view returns (bool valid) {
        uint256 budget = VERIFIER_GAS_LIMIT;
        bytes32 expected = bytes32(magic);
        assembly ("memory-safe") {
            mstore(0x00, 0)
            let success := staticcall(budget, target, add(input, 0x20), mload(input), 0x00, 0x20)
            valid := and(success, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }
}
