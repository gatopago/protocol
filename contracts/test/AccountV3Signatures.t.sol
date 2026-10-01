// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC7913SignatureVerifier} from "@openzeppelin/contracts/interfaces/IERC7913.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";

contract V3SignatureHarness {
    function validate(T.SecurityPolicy memory policy) external pure returns (bytes32) {
        P.validate(policy);
        return T.hashPolicy(policy);
    }

    function verify(T.SignerDescriptor memory signer, bytes32 digest, bytes memory signature)
        external
        view
        returns (bool)
    {
        return S.verifySigner(signer, digest, signature);
    }

    function quorum(T.SecurityPolicy memory policy, uint8 role, bytes32 digest, S.Signature[] memory signatures)
        external
        view
        returns (bool)
    {
        return S.verifyQuorum(policy, role, digest, signatures);
    }

    function validatedQuorum(
        T.SecurityPolicy memory policy,
        uint8 role,
        bytes32 digest,
        S.Signature[] memory signatures
    ) external view returns (bool) {
        P.validate(policy);
        return S.verifyValidatedQuorum(policy, role, digest, signatures);
    }
}

/// @dev Local test wallet with real ECDSA validation and revocable authorization (same runtime codehash).
contract V3TestContractSigner is IERC1271 {
    address private immutable owner;
    bool public revoked;

    constructor(address owner_) {
        owner = owner_;
    }

    function revoke() external {
        revoked = true;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return !revoked && err == ECDSA.RecoverError.NoError && recovered == owner
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}

/// @dev Hostile test doubles, deliberately NOT trusted production signature verifiers.
contract V3HostileVerifier {
    uint256 private immutable behavior;
    bytes32 private immutable answer;
    uint256 public writes;

    constructor(uint256 behavior_, bytes4 answer_) {
        behavior = behavior_;
        answer = bytes32(answer_);
    }

    fallback() external {
        uint256 mode = behavior;
        bytes32 magic = answer;
        if (mode == 4) ++writes;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, magic)
            switch mode
            case 0 { return(ptr, 0x20) }
            case 1 { return(ptr, 4) }
            case 2 { revert(ptr, 0x20) }
            case 3 { for {} 1 {} {} }
            case 4 { return(ptr, 0x20) }
            case 5 {
                // Noncanonical padding after the bytes4.
                mstore(ptr, or(magic, 1))
                return(ptr, 0x20)
            }
            case 6 {
                // Large valid prefix; the caller must not allocate/copy the full return buffer.
                return(ptr, 0x10000)
            }
            default { return(ptr, 0) }
        }
    }
}

contract AccountV3SignaturesTest is Test {
    using stdJson for string;
    V3SignatureHarness private harness;
    AccountV3WebAuthnVerifier private passkeyVerifier;
    address private alice;
    address private bob;
    address private helper;
    // Ephemeral synthetic test-only scalars from forge-std; never read/export an operational key.
    uint256 private aliceKey;
    uint256 private bobKey;
    uint256 private helperKey;
    bytes32 private constant DIGEST = keccak256("GatoPago V3 local authorization test");

    function setUp() public {
        harness = new V3SignatureHarness();
        passkeyVerifier = new AccountV3WebAuthnVerifier();
        (alice, aliceKey) = makeAddrAndKey("v3-alice-test-only");
        (bob, bobKey) = makeAddrAndKey("v3-bob-test-only");
        (helper, helperKey) = makeAddrAndKey("v3-helper-test-only");
        vm.mockCall(address(0x100), bytes(""), bytes(""));
    }

    function test_activePolicyPreservesHash() public view {
        T.SecurityPolicy memory policy = _active();
        assertEq(harness.validate(policy), T.hashPolicy(policy));
    }

    function testFuzz_validatedQuorumRetainsThresholdRoleDuplicateAndSignatureChecks(bytes32 digest, uint8 variant)
        public
        view
    {
        T.SecurityPolicy memory policy = _active();
        S.Signature[] memory votes = new S.Signature[](2);
        votes[0] = S.Signature(_index(policy, abi.encodePacked(alice)), _sign(aliceKey, digest));
        votes[1] = S.Signature(_index(policy, abi.encodePacked(bob)), _sign(bobKey, digest));
        variant %= 7;
        uint8 role = P.ADMIN;
        if (variant == 1) votes[1] = votes[0];
        if (variant == 2) votes[1].signature = hex"abcd";
        if (variant == 3) votes[1].signerIndex = 16;
        if (variant == 4) role = 8;
        if (variant == 5) digest ^= bytes32(uint256(1));
        if (variant == 6) votes = new S.Signature[](0);
        assertEq(harness.validatedQuorum(policy, role, digest, votes), harness.quorum(policy, role, digest, votes));
    }

    function test_realWebAuthnQuorumWithEcdsa() public view {
        (T.SignerDescriptor memory signer, bytes32 digest, bytes memory signature) = _browser();
        T.SecurityPolicy memory policy = _active();
        policy.signers[0] = signer;
        policy.signers[1] = _ecdsa(alice);
        _sort(policy);
        S.Signature[] memory signatures = new S.Signature[](2);
        uint8 webIndex = _index(policy, signer.key);
        signatures[0] = S.Signature(webIndex, signature);
        signatures[1] = S.Signature(_index(policy, abi.encodePacked(alice)), _sign(aliceKey, digest));
        assertTrue(harness.quorum(policy, P.ADMIN, digest, signatures));
        assertFalse(harness.quorum(policy, P.ADMIN, digest ^ bytes32(uint256(1)), signatures));
    }

    function testFuzz_ecdsaExactDigest(bytes32 digest) public view {
        bytes memory signature = _sign(aliceKey, digest);
        assertTrue(harness.verify(_ecdsa(alice), digest, signature));
        assertFalse(harness.verify(_ecdsa(alice), digest ^ bytes32(uint256(1)), signature));
        assertFalse(harness.verify(_ecdsa(bob), digest, signature));
    }

    function test_ecdsaDoesNotDispatchToContractCode() public {
        V3HostileVerifier fake = new V3HostileVerifier(0, IERC1271.isValidSignature.selector);
        vm.etch(alice, address(fake).code);
        assertFalse(harness.verify(_ecdsa(alice), DIGEST, hex"00"));
        assertTrue(harness.verify(_ecdsa(alice), DIGEST, _sign(aliceKey, DIGEST)));
    }

    function test_ecdsaRejectsHighSBadVAndCompact() public view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, DIGEST);
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        assertFalse(harness.verify(_ecdsa(alice), DIGEST, highS));
        assertFalse(harness.verify(_ecdsa(alice), DIGEST, abi.encodePacked(r, s, uint8(1))));
        assertFalse(harness.verify(_ecdsa(alice), DIGEST, abi.encodePacked(r, s)));
    }

    function test_contractSignatureIsRevocableWithoutCodeChange() public {
        V3TestContractSigner wallet = new V3TestContractSigner(alice);
        T.SignerDescriptor memory signer = _contract(address(wallet));
        bytes memory signature = _sign(aliceKey, DIGEST);
        assertTrue(harness.verify(signer, DIGEST, signature));
        assertFalse(harness.verify(signer, DIGEST, _sign(bobKey, DIGEST)));
        wallet.revoke();
        assertEq(address(wallet).codehash, signer.verifierCodeHash);
        assertFalse(harness.verify(signer, DIGEST, signature));
    }

    function test_codehashAndCodePresenceAreCheckedEveryTime() public {
        V3TestContractSigner wallet = new V3TestContractSigner(alice);
        T.SignerDescriptor memory signer = _contract(address(wallet));
        bytes memory signature = _sign(aliceKey, DIGEST);
        signer.verifierCodeHash = bytes32(uint256(1));
        assertFalse(harness.verify(signer, DIGEST, signature));
        signer.verifierCodeHash = address(wallet).codehash;
        V3HostileVerifier replacement = new V3HostileVerifier(0, IERC1271.isValidSignature.selector);
        vm.etch(address(wallet), address(replacement).code);
        assertFalse(harness.verify(signer, DIGEST, signature));
        vm.etch(address(wallet), bytes(""));
        signer.verifierCodeHash = address(wallet).codehash;
        assertFalse(harness.verify(signer, DIGEST, signature));
    }

    function test_erc1271RequiresWalletKeyNotAdapterAlias() public {
        T.SignerDescriptor memory signer = _contract(address(new V3TestContractSigner(alice)));
        signer.key = abi.encodePacked(bob);
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, _sign(aliceKey, DIGEST));
    }

    function testFuzz_hostileReturnOrRevertFailsClosed(uint8 seed) public {
        uint256 mode = bound(seed, 1, 5);
        V3HostileVerifier hostile = new V3HostileVerifier(mode, IERC1271.isValidSignature.selector);
        uint256 beforeGas = gasleft();
        assertFalse(harness.verify(_contract(address(hostile)), DIGEST, hex"aa"));
        assertLt(beforeGas - gasleft(), S.VERIFIER_GAS_LIMIT + 60_000);
        assertEq(hostile.writes(), 0);
    }

    function test_wrongMagicAndEmptyReturnDoNotAuthorize() public {
        V3HostileVerifier wrong = new V3HostileVerifier(0, IERC7913SignatureVerifier.verify.selector);
        V3HostileVerifier empty = new V3HostileVerifier(7, IERC1271.isValidSignature.selector);
        assertFalse(harness.verify(_contract(address(wrong)), DIGEST, hex"aa"));
        assertFalse(harness.verify(_contract(address(empty)), DIGEST, hex"aa"));
        (T.SignerDescriptor memory signer,,) = _browser();
        V3HostileVerifier wrongWeb = new V3HostileVerifier(0, IERC1271.isValidSignature.selector);
        signer.verifier = address(wrongWeb);
        signer.verifierCodeHash = address(wrongWeb).codehash;
        assertFalse(harness.verify(signer, DIGEST, hex"aa"));
    }

    function test_largeReturnIsNotCopiedByCaller() public {
        V3HostileVerifier large = new V3HostileVerifier(6, IERC1271.isValidSignature.selector);
        uint256 beforeGas = gasleft();
        assertTrue(harness.verify(_contract(address(large)), DIGEST, hex"aa"));
        assertLt(beforeGas - gasleft(), 60_000);
    }

    function test_oversizedSignaturesAreRejectedForAllKinds() public view {
        bytes memory signature = new bytes(S.MAX_SIGNATURE_BYTES + 1);
        assertFalse(harness.verify(_ecdsa(alice), DIGEST, signature));
        (T.SignerDescriptor memory signer,,) = _browser();
        assertFalse(harness.verify(signer, DIGEST, signature));
    }

    function testFuzz_quorumUsesDistinctMembersAndSelectedThreshold(bytes32 digest) public view {
        T.SecurityPolicy memory policy = _active();
        S.Signature[] memory signatures = _votes(policy, digest, true);
        assertTrue(harness.quorum(policy, P.ADMIN, digest, signatures));
        assertTrue(harness.quorum(policy, P.ADMIN, digest, signatures));
        S.Signature memory first = signatures[0];
        signatures[0] = signatures[1];
        signatures[1] = first;
        assertTrue(harness.quorum(policy, P.ADMIN, digest, signatures));
        signatures[1] = signatures[0];
        assertFalse(harness.quorum(policy, P.ADMIN, digest, signatures));
    }

    function test_quorumRejectsUnknownRolesInsufficientAndOutOfRangeVotes() public view {
        T.SecurityPolicy memory policy = _active();
        S.Signature[] memory signatures = _votes(policy, DIGEST, false);
        assertTrue(harness.quorum(policy, P.SPEND, DIGEST, signatures));
        assertFalse(harness.quorum(policy, P.ADMIN, DIGEST, signatures));
        assertFalse(harness.quorum(policy, P.SPEND | P.ADMIN, DIGEST, signatures));
        assertFalse(harness.quorum(policy, 0, DIGEST, signatures));
        assertFalse(harness.quorum(policy, 8, DIGEST, signatures));
        assertFalse(harness.quorum(policy, P.SPEND, DIGEST, new S.Signature[](0)));
        assertFalse(harness.quorum(policy, P.SPEND, DIGEST, new S.Signature[](3)));
        signatures[0].signerIndex = 255;
        assertFalse(harness.quorum(policy, P.SPEND, DIGEST, signatures));
    }

    function test_invalidExtraSignatureInvalidatesWholeQuorum() public view {
        T.SecurityPolicy memory policy = _active();
        S.Signature[] memory signatures = _votes(policy, DIGEST, true);
        signatures[1].signature = hex"00";
        assertFalse(harness.quorum(policy, P.SPEND, DIGEST, signatures));
    }

    function test_badModesAndCounts() public {
        T.SecurityPolicy memory policy = _active();
        policy.mode = 2;
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        harness.validate(policy);
        policy.mode = P.ACTIVE;
        policy.signers = new T.SignerDescriptor[](0);
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        harness.validate(policy);
        policy.signers = new T.SignerDescriptor[](17);
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        harness.validate(policy);
    }

    function testFuzz_thresholdsAreReachable(uint16 spend, uint16 admin) public {
        T.SecurityPolicy memory policy = _active();
        policy.spendThreshold = spend;
        policy.adminThreshold = admin;
        bool valid = spend >= 1 && spend <= 2 && admin >= 1 && admin <= 2;
        if (!valid) vm.expectRevert(P.AccountV3Policy__InvalidThreshold.selector);
        harness.validate(policy);
    }

    function testFuzz_delaysRespectBounds(uint48 upgrade) public {
        T.SecurityPolicy memory policy = _active();
        policy.upgradeDelaySeconds = upgrade;
        bool valid = upgrade >= 72 hours && upgrade <= 30 days;
        if (!valid) vm.expectRevert(P.AccountV3Policy__InvalidDelay.selector);
        harness.validate(policy);
    }

    function test_minAndMaxDelaysAndMaximumSigners() public view {
        T.SecurityPolicy memory policy = _active();
        policy.upgradeDelaySeconds = 72 hours;
        policy.signers = new T.SignerDescriptor[](P.MAX_SIGNERS);
        for (uint256 i; i < P.MAX_SIGNERS; ++i) {
            policy.signers[i] = _ecdsa(address(SafeCast.toUint160(i + 1)));
        }
        policy.spendThreshold = 16;
        policy.adminThreshold = 16;
        _sort(policy);
        harness.validate(policy);
    }

    function test_unsortedAndDuplicateMembers() public {
        T.SecurityPolicy memory policy = _active();
        T.SignerDescriptor memory first = policy.signers[0];
        policy.signers[0] = policy.signers[1];
        policy.signers[1] = first;
        vm.expectRevert(P.AccountV3Policy__UnsortedSigners.selector);
        harness.validate(policy);
        policy.signers[1] = policy.signers[0];
        vm.expectRevert(P.AccountV3Policy__UnsortedSigners.selector);
        harness.validate(policy);
    }

    function test_webAuthnAliasesCannotCountAsTwoKeys() public {
        (T.SignerDescriptor memory signer,,) = _browser();
        T.SecurityPolicy memory policy = _active();
        policy.signers[0] = signer;
        policy.signers[1] = T.SignerDescriptor(
            P.WEBAUTHN,
            address(123),
            bytes32(uint256(456)),
            abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), Bytes.slice(signer.key, 64)),
            3
        );
        _sort(policy);
        vm.expectRevert(P.AccountV3Policy__DuplicateKey.selector);
        harness.validate(policy);
    }

    function test_ecdsaAndContractAliasesCannotCountTwice() public {
        T.SecurityPolicy memory policy = _active();
        policy.signers[0] = _ecdsa(alice);
        policy.signers[1] = T.SignerDescriptor(P.ERC1271, alice, bytes32(uint256(1)), abi.encodePacked(alice), 3);
        _sort(policy);
        vm.expectRevert(P.AccountV3Policy__DuplicateKey.selector);
        harness.validate(policy);
    }

    function testFuzz_invalidRoles(uint8 roles) public {
        roles = uint8(bound(roles, 4, 255));
        T.SecurityPolicy memory policy = _active();
        policy.signers[0].roles = roles;
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.validate(policy);
    }

    function test_invalidKeyLengthsAndKinds() public {
        T.SignerDescriptor memory signer = _ecdsa(alice);
        signer.kind = 3;
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
        signer.kind = P.ECDSA;
        signer.key = new bytes(20);
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
        signer.key = abi.encodePacked(alice, bytes1(0));
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
        signer.kind = P.WEBAUTHN;
        signer.key = new bytes(128);
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
    }

    function test_invalidVerifierDescriptors() public {
        T.SignerDescriptor memory signer = _ecdsa(alice);
        signer.verifier = bob;
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
        signer.verifier = address(0);
        signer.verifierCodeHash = bytes32(uint256(1));
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
        (signer,,) = _browser();
        signer.verifierCodeHash = bytes32(0);
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.verify(signer, DIGEST, hex"00");
    }

    function _active() private view returns (T.SecurityPolicy memory policy) {
        policy.mode = P.ACTIVE;
        policy.signers = new T.SignerDescriptor[](2);
        policy.signers[0] = _ecdsa(alice);
        policy.signers[1] = _ecdsa(bob);
        policy.spendThreshold = 1;
        policy.adminThreshold = 2;
        policy.upgradeDelaySeconds = 72 hours;
        _sort(policy);
    }

    function _bootstrap(T.SignerDescriptor memory signer) private pure returns (T.SecurityPolicy memory policy) {
        policy.signers = new T.SignerDescriptor[](1);
        signer.roles = P.SPEND;
        policy.signers[0] = signer;
        policy.spendThreshold = 1;
        policy.upgradeDelaySeconds = 72 hours;
    }

    function _ecdsa(address key) private pure returns (T.SignerDescriptor memory) {
        return T.SignerDescriptor(P.ECDSA, address(0), bytes32(0), abi.encodePacked(key), 3);
    }

    function _contract(address key) private view returns (T.SignerDescriptor memory) {
        return T.SignerDescriptor(P.ERC1271, key, key.codehash, abi.encodePacked(key), 3);
    }

    function _browser()
        private
        view
        returns (T.SignerDescriptor memory signer, bytes32 digest, bytes memory signature)
    {
        string memory vector = vm.readFile("test/fixtures/v3-webauthn-encoding.json");
        signer = T.SignerDescriptor(
            P.WEBAUTHN, address(passkeyVerifier), address(passkeyVerifier).codehash, vector.readBytes(".key"), 3
        );
        digest = vector.readBytes32(".challenge");
        signature = vector.readBytes(".signature");
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sort(T.SecurityPolicy memory policy) private pure {
        for (uint256 i = 1; i < policy.signers.length; ++i) {
            uint256 j = i;
            while (j > 0 && T.signerId(policy.signers[j - 1]) > T.signerId(policy.signers[j])) {
                T.SignerDescriptor memory previous = policy.signers[j - 1];
                policy.signers[j - 1] = policy.signers[j];
                policy.signers[j] = previous;
                --j;
            }
        }
    }

    function _index(T.SecurityPolicy memory policy, bytes memory key) private pure returns (uint8) {
        for (uint256 i; i < policy.signers.length; ++i) {
            if (keccak256(policy.signers[i].key) == keccak256(key)) return SafeCast.toUint8(i);
        }
        revert("test signer missing");
    }

    function _votes(T.SecurityPolicy memory policy, bytes32 digest, bool both)
        private
        view
        returns (S.Signature[] memory votes)
    {
        votes = new S.Signature[](both ? 2 : 1);
        votes[0] = S.Signature(_index(policy, abi.encodePacked(alice)), _sign(aliceKey, digest));
        if (both) votes[1] = S.Signature(_index(policy, abi.encodePacked(bob)), _sign(bobKey, digest));
    }
}
