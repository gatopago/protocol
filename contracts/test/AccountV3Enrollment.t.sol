// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";

contract V3EnrollmentHarness {
    function verify(
        T.SecurityPolicy memory previous,
        T.SecurityPolicy memory next,
        E.ChangeKind kind,
        T.SecurityChange memory change,
        S.Signature[] memory authorizations,
        S.Signature[] memory enrollments
    ) external view returns (bool) {
        return E.verifyChange(previous, next, kind, change, authorizations, enrollments);
    }
}

contract AccountV3EnrollmentTest is Test {
    V3EnrollmentHarness private harness;
    T.SecurityPolicy private previous;
    T.SecurityPolicy private next;
    mapping(address key => uint256 scalar) private testKeys;
    address private alice;
    address private bob;
    address private carol;

    function setUp() public {
        harness = new V3EnrollmentHarness();
        // Ephemeral synthetic test-only keys, never imported from configuration or exported.
        uint256 scalar;
        (alice, scalar) = makeAddrAndKey("enrollment-alice-test");
        testKeys[alice] = scalar;
        (bob, scalar) = makeAddrAndKey("enrollment-bob-test");
        testKeys[bob] = scalar;
        (carol, scalar) = makeAddrAndKey("enrollment-carol-test");
        testKeys[carol] = scalar;
        previous = _policy(alice, bob);
        next = _policy(alice, carol);
        vm.warp(1_000_000);
    }

    function test_oldAuthorityAndNewPossessionAreBothRequired() public view {
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        assertTrue(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, new S.Signature[](0)));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, new S.Signature[](0), proofs));
        auth[0].signature = proofs[0].signature;
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
    }

    function testFuzz_changedProposalCannotReuseEnrollmentWithFreshAdminConsent(uint8 mutation) public view {
        mutation = SafeCast.toUint8(bound(mutation, 0, 6));
        T.SecurityChange memory change = _change();
        S.Signature[] memory oldProofs = _proofs(change, E.ChangeKind.Security, address(harness));
        if (mutation == 0) ++change.nonce;
        else if (mutation == 1) ++change.securityVersion;
        else if (mutation == 2) change.accountId = keccak256("another account");
        else if (mutation == 3) change.previousManifestHash = keccak256("another predecessor");
        else if (mutation == 4) change.chainScopeHash = keccak256("another scope");
        else if (mutation == 5) --change.validAfter;
        else ++change.validUntil;
        S.Signature[] memory freshAuth = _auth(change, E.ChangeKind.Security, address(harness));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, freshAuth, oldProofs));
        assertTrue(
            harness.verify(
                previous,
                next,
                E.ChangeKind.Security,
                change,
                freshAuth,
                _proofs(change, E.ChangeKind.Security, address(harness))
            )
        );
    }

    function test_chainAndAccountDomainCannotBeSubstituted() public {
        T.SecurityChange memory change = _change();
        S.Signature[] memory proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        vm.chainId(block.chainid + 1);
        assertFalse(
            harness.verify(
                previous,
                next,
                E.ChangeKind.Security,
                change,
                _auth(change, E.ChangeKind.Security, address(harness)),
                proofs
            )
        );
        proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        V3EnrollmentHarness other = new V3EnrollmentHarness();
        assertFalse(
            other.verify(
                previous,
                next,
                E.ChangeKind.Security,
                change,
                _auth(change, E.ChangeKind.Security, address(other)),
                proofs
            )
        );
    }

    function test_roleChangeRequiresPossessionEvenWithSameSignerId() public {
        next = previous;
        next.signers[0].roles = P.ADMIN;
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, new S.Signature[](0)));
        S.Signature[] memory proofs = new S.Signature[](1);
        T.SignerDescriptor memory signer = next.signers[0];
        proofs[0] = S.Signature(
            0,
            _sign(address(bytes20(signer.key)), _proofDigest(signer, change, E.ChangeKind.Security, address(harness)))
        );
        assertTrue(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
    }

    function test_thresholdOnlyChangeNeedsNoEnrollmentButStillNeedsAuthority() public {
        next = previous;
        next.spendThreshold = 2;
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        assertTrue(harness.verify(previous, next, E.ChangeKind.Security, change, auth, new S.Signature[](0)));
        assertFalse(
            harness.verify(previous, next, E.ChangeKind.Security, change, new S.Signature[](0), new S.Signature[](0))
        );
    }

    function test_roleChangeRequiresPossessionWithoutChangingSignerId() public {
        T.SecurityPolicy memory expanded = previous;
        expanded.signers = new T.SignerDescriptor[](3);
        expanded.signers[0] = _ecdsa(alice);
        expanded.signers[1] = _ecdsa(bob);
        expanded.signers[2] = _ecdsa(carol);
        expanded.signers[2].roles = P.ADMIN;
        _sort(expanded);
        previous = expanded;
        next = expanded;
        uint8 index = _index(next, abi.encodePacked(carol));
        next.signers[index].roles = P.SPEND | P.ADMIN;
        T.SecurityChange memory change = _change();
        bytes32 digest = _context(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory auth = new S.Signature[](2);
        auth[0] = S.Signature(_index(previous, abi.encodePacked(alice)), _sign(alice, digest));
        auth[1] = S.Signature(_index(previous, abi.encodePacked(bob)), _sign(bob, digest));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, new S.Signature[](0)));
        assertTrue(
            harness.verify(
                previous,
                next,
                E.ChangeKind.Security,
                change,
                auth,
                _proofs(change, E.ChangeKind.Security, address(harness))
            )
        );
    }

    function test_missingDuplicateExtraAndOutOfRangeProofs() public view {
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory repeated = new S.Signature[](2);
        repeated[0] = proofs[0];
        repeated[1] = proofs[0];
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, repeated));
        proofs[0].signerIndex = 255;
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        proofs[0].signerIndex = _index(next, abi.encodePacked(alice));
        proofs[0].signature = _sign(
            alice, _proofDigest(next.signers[proofs[0].signerIndex], change, E.ChangeKind.Security, address(harness))
        );
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, new S.Signature[](17)));
    }

    function test_expiredAndFutureWindowsFailEvenWithValidSignatures() public {
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        vm.warp(change.validAfter - 1);
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        vm.warp(change.validAfter);
        assertTrue(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        vm.warp(change.validUntil);
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
    }

    function test_wrongGenerationAndPolicyCommitmentFail() public view {
        T.SecurityChange memory change = _change();
        S.Signature[] memory auth = _auth(change, E.ChangeKind.Security, address(harness));
        S.Signature[] memory proofs = _proofs(change, E.ChangeKind.Security, address(harness));
        change.generation = 2;
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
        change.generation = 3;
        change.nextPolicyHash = keccak256("not this policy");
        assertFalse(harness.verify(previous, next, E.ChangeKind.Security, change, auth, proofs));
    }

    function _policy(address a, address b) private pure returns (T.SecurityPolicy memory policy) {
        policy.mode = P.ACTIVE;
        policy.signers = new T.SignerDescriptor[](2);
        policy.signers[0] = _ecdsa(a);
        policy.signers[1] = _ecdsa(b);
        policy.spendThreshold = 1;
        policy.adminThreshold = 2;
        policy.upgradeDelaySeconds = 72 hours;
        _sort(policy);
    }

    function _ecdsa(address key) private pure returns (T.SignerDescriptor memory) {
        return T.SignerDescriptor(P.ECDSA, address(0), bytes32(0), abi.encodePacked(key), 3);
    }

    function _sort(T.SecurityPolicy memory policy) private pure {
        for (uint256 i = 1; i < policy.signers.length; ++i) {
            uint256 j = i;
            while (j > 0 && T.signerId(policy.signers[j - 1]) > T.signerId(policy.signers[j])) {
                T.SignerDescriptor memory first = policy.signers[j - 1];
                policy.signers[j - 1] = policy.signers[j];
                policy.signers[j] = first;
                --j;
            }
        }
    }

    function _change() private view returns (T.SecurityChange memory) {
        return T.SecurityChange(
            keccak256("test-account"),
            3,
            1,
            keccak256("test-predecessor"),
            T.hashPolicy(next),
            keccak256("test-scope"),
            5,
            999_999,
            1_000_299,
            1_500_000
        );
    }

    function _context(T.SecurityChange memory change, E.ChangeKind kind, address account)
        private
        view
        returns (bytes32)
    {
        bytes32 hash = E.hashChange(kind, change);
        return T.digest(block.chainid, account, hash);
    }

    function _auth(T.SecurityChange memory change, E.ChangeKind kind, address account)
        private
        view
        returns (S.Signature[] memory auth)
    {
        auth = new S.Signature[](2);
        for (uint256 i; i < 2; ++i) {
            auth[i] = S.Signature(
                SafeCast.toUint8(i), _sign(address(bytes20(previous.signers[i].key)), _context(change, kind, account))
            );
        }
    }

    function _proofs(T.SecurityChange memory change, E.ChangeKind kind, address account)
        private
        view
        returns (S.Signature[] memory proofs)
    {
        proofs = new S.Signature[](1);
        uint8 index = _index(next, abi.encodePacked(carol));
        proofs[0] = S.Signature(index, _sign(carol, _proofDigest(next.signers[index], change, kind, account)));
    }

    function _proofDigest(
        T.SignerDescriptor memory signer,
        T.SecurityChange memory change,
        E.ChangeKind kind,
        address account
    ) private view returns (bytes32) {
        T.EnrollmentProof memory proof = T.EnrollmentProof(
            change.accountId,
            change.generation,
            change.securityVersion,
            T.signerId(signer),
            change.nextPolicyHash,
            _context(change, kind, account),
            change.nonce,
            change.validAfter,
            change.validUntil
        );
        return T.digest(block.chainid, account, T.hashEnrollment(proof));
    }

    function _sign(address key, bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(testKeys[key], digest);
        return abi.encodePacked(r, s, v);
    }

    function _webSign(bytes32 digest) private pure returns (bytes memory) {
        bytes memory data = abi.encodePacked(sha256("gatopago.com"), bytes1(0x05), bytes4(0));
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://gatopago.com","crossOrigin":false}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(1, sha256(abi.encodePacked(data, sha256(bytes(json)))));
        if (uint256(s) > P256.N / 2) s = bytes32(P256.N - uint256(s));
        return abi.encode(r, s, uint256(23), uint256(1), data, json);
    }

    function _index(T.SecurityPolicy memory policy, bytes memory key) private pure returns (uint8) {
        for (uint256 i; i < policy.signers.length; ++i) {
            if (keccak256(policy.signers[i].key) == keccak256(key)) return SafeCast.toUint8(i);
        }
        revert("test signer missing");
    }
}
