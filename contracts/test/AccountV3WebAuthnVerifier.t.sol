// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {IERC7913SignatureVerifier} from "@openzeppelin/contracts/interfaces/IERC7913.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";

contract AccountV3WebAuthnVerifierTest is Test {
    using stdJson for string;
    // Public mathematical test scalar, NOT a deployment key or a user's credential.
    uint256 private constant TEST_SCALAR = 1;
    bytes4 private constant VALID = IERC7913SignatureVerifier.verify.selector;
    bytes4 private constant INVALID = 0xffffffff;
    string private constant ORIGIN = "https://gatopago.com";
    bytes32 private constant RP_HASH = sha256("gatopago.com");
    AccountV3WebAuthnVerifier private verifier;

    function setUp() public {
        verifier = new AccountV3WebAuthnVerifier();
        // Exercise real Solidity P256 verification, not a mocked successful verifier.
        // Native precompile availability/correctness still needs a per-chain fork proof.
        vm.mockCall(address(0x100), bytes(""), bytes(""));
    }

    function testFuzz_validAssertionWithRealP256(uint256 seed, bytes32 challenge) public view {
        seed = bound(seed, 1, P256.N - 1);
        WebAuthn.WebAuthnAuth memory auth = _auth(seed, challenge, RP_HASH, 0x05, ORIGIN);
        assertEq(verifier.verify(_key(seed, RP_HASH, sha256(bytes(ORIGIN))), challenge, _encode(auth)), VALID);
    }

    function test_acceptsExactTypeScriptEncoderBytes() public view {
        string memory vector = vm.readFile("test/fixtures/v3-webauthn-encoding.json");
        bytes memory key = vector.readBytes(".key");
        bytes memory signature = vector.readBytes(".signature");
        bytes32 challenge = vector.readBytes32(".challenge");
        assertEq(verifier.verify(key, challenge, signature), VALID);
        // The same encoded authorization cannot sign another digest.
        assertEq(verifier.verify(key, challenge ^ bytes32(uint256(1)), signature), INVALID);
    }

    function test_realChromiumAssertionWithHighSNormalization() public view {
        string memory fixture = vm.readFile("test/fixtures/v3-webauthn-chromium.json");
        bytes memory spki = fixture.readBytes(".spki");
        assertEq(spki.length, 91);
        assertEq(Bytes.slice(spki, 0, 27), hex"3059301306072a8648ce3d020106082a8648ce3d03010703420004");
        bytes memory key = abi.encodePacked(
            sha256(bytes(fixture.readString(".rpId"))),
            sha256(bytes(fixture.readString(".origin"))),
            Bytes.slice(spki, 27)
        );
        WebAuthn.WebAuthnAuth memory auth = WebAuthn.WebAuthnAuth({
            r: fixture.readBytes32(".r"),
            s: fixture.readBytes32(".sNormalized"),
            challengeIndex: 23,
            typeIndex: 1,
            authenticatorData: fixture.readBytes(".authenticatorData"),
            clientDataJSON: fixture.readString(".clientDataJSON")
        });
        bytes32 challenge = fixture.readBytes32(".challenge");
        assertEq(verifier.verify(key, challenge, _encode(auth)), VALID);
        auth.s = fixture.readBytes32(".sRaw");
        assertEq(verifier.verify(key, challenge, _encode(auth)), INVALID);
    }

    function testFuzz_wrongRpIsRejectedEvenWhenResigned(bytes32 rp) public view {
        vm.assume(rp != RP_HASH);
        bytes32 challenge = keccak256("v3-initialization");
        assertEq(verifier.verify(_key(), challenge, _encode(_auth(TEST_SCALAR, challenge, rp, 0x05, ORIGIN))), INVALID);
    }

    function test_wrongOriginsAreRejectedEvenWhenResigned() public view {
        string[5] memory origins = [
            "https://app.gatopago.com",
            "https://other.gatopago.com",
            "https://gatopago.com/",
            "http://gatopago.com",
            "https://gatopago.com.attacker.test"
        ];
        for (uint256 i; i < origins.length; ++i) {
            assertEq(
                verifier.verify(_key(), bytes32(0), _encode(_auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, origins[i]))),
                INVALID
            );
        }
    }

    function test_zeroRpOrOriginCommitmentCannotAuthorize() public view {
        bytes memory signature = _encode(_auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN));
        assertEq(verifier.verify(_key(TEST_SCALAR, bytes32(0), sha256(bytes(ORIGIN))), bytes32(0), signature), INVALID);
        assertEq(verifier.verify(_key(TEST_SCALAR, RP_HASH, bytes32(0)), bytes32(0), signature), INVALID);
    }

    function test_flagsEnforcePresenceVerificationAndBackupConsistency() public view {
        bytes1[7] memory flags = [bytes1(0x00), 0x01, 0x04, 0x15, 0x05, 0x0d, 0x1d];
        for (uint256 i; i < flags.length; ++i) {
            bytes4 expected = i < 4 ? INVALID : VALID;
            assertEq(
                verifier.verify(_key(), bytes32(0), _encode(_auth(TEST_SCALAR, bytes32(0), RP_HASH, flags[i], ORIGIN))),
                expected
            );
        }
    }

    function test_additionalClientFieldsAreAllowedAndCoveredBySignature() public view {
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x1d, ORIGIN);
        bytes memory json = bytes(auth.clientDataJSON);
        assembly ("memory-safe") { mstore(json, sub(mload(json), 1)) }
        auth.clientDataJSON = string.concat(string(json), ',"other_keys_can_be_added_here":"future browser data"}');
        auth = _resign(TEST_SCALAR, auth);
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), VALID);
        auth.clientDataJSON = string.concat(auth.clientDataJSON, " ");
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
    }

    function test_nestedTypeAndChallengeCannotAuthorize() public view {
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN);
        auth.clientDataJSON = string.concat('{"nested":', auth.clientDataJSON, "}");
        auth.typeIndex += 10;
        auth.challengeIndex += 10;
        auth = _resign(TEST_SCALAR, auth);
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
    }

    function test_crossOriginAndMalformedSuffixAreRejected() public view {
        string memory prefix = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(bytes32(0))),
            '","origin":"',
            ORIGIN
        );
        string[4] memory suffixes = ['","crossOrigin":true}', '","crossOrigin":falsex}', '","crossOrigin":false', '"}'];
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN);
        for (uint256 i; i < suffixes.length; ++i) {
            auth.clientDataJSON = string.concat(prefix, suffixes[i]);
            auth = _resign(TEST_SCALAR, auth);
            assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
        }
    }

    function test_unescapedOriginProfileRejectsEscapesControlsAndEmptyOrigin() public view {
        string[4] memory origins = ["", "https://gato\\pago.com", "https://gato pago.com", "https://gato\npago.com"];
        for (uint256 i; i < origins.length; ++i) {
            // Even pinning the raw bytes does not make an invalid serialization acceptable.
            bytes memory key = _key(TEST_SCALAR, RP_HASH, sha256(bytes(origins[i])));
            assertEq(
                verifier.verify(key, bytes32(0), _encode(_auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, origins[i]))),
                INVALID
            );
        }
    }

    function test_indexesCannotWrapOrPointElsewhere() public view {
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN);
        auth.typeIndex = type(uint256).max;
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
        auth.typeIndex = 1;
        auth.challengeIndex = type(uint256).max;
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
    }

    function test_truncationOffsetsAndOversizedInputsFailClosed() public view {
        bytes memory signature = _encode(_auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN));
        bytes memory key = _key();
        for (uint256 length; length < 192; ++length) {
            assertEq(verifier.verify(key, bytes32(0), new bytes(length)), INVALID);
        }
        assertEq(verifier.verify(new bytes(64), bytes32(0), signature), INVALID);
        assertEq(verifier.verify(abi.encodePacked(key, bytes1(0)), bytes32(0), signature), INVALID);
        assertEq(verifier.verify(key, bytes32(0), new bytes(4097)), INVALID);
        assertEq(
            verifier.verify(
                key,
                bytes32(0),
                abi.encode(bytes32(0), bytes32(0), uint256(23), uint256(1), type(uint256).max, uint256(192))
            ),
            INVALID
        );
    }

    function test_authenticatorAndClientDataBounds() public view {
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, bytes32(0), RP_HASH, 0x05, ORIGIN);
        auth.authenticatorData = new bytes(36);
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
        auth.authenticatorData = new bytes(1025);
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
        auth.authenticatorData = abi.encodePacked(RP_HASH, bytes1(0x05), bytes4(0));
        auth.clientDataJSON = string(new bytes(2049));
        assertEq(verifier.verify(_key(), bytes32(0), _encode(auth)), INVALID);
    }

    function test_keySignatureAndHighSFailuresHaveNoRawP256Fallback() public view {
        bytes32 challenge = keccak256("test challenge");
        WebAuthn.WebAuthnAuth memory auth = _auth(TEST_SCALAR, challenge, RP_HASH, 0x05, ORIGIN);
        assertEq(verifier.verify(_key(2, RP_HASH, sha256(bytes(ORIGIN))), challenge, _encode(auth)), INVALID);
        assertEq(verifier.verify(_key(), challenge, abi.encode(auth.r, auth.s)), INVALID);
        auth.s = bytes32(P256.N - uint256(auth.s));
        assertEq(verifier.verify(_key(), challenge, _encode(auth)), INVALID);
        auth.s = bytes32(0);
        assertEq(verifier.verify(_key(), challenge, _encode(auth)), INVALID);
    }

    function test_eip712AccountChainPurposeVersionAndNonceChangeTheChallenge() public view {
        T.SecurityChange memory change;
        change.generation = 3;
        change.securityVersion = 1;
        bytes32 challenge = T.digest(84532, address(0xbeef), T.hashSecurity(change));
        bytes memory signature = _encode(_auth(TEST_SCALAR, challenge, RP_HASH, 0x05, ORIGIN));
        assertEq(verifier.verify(_key(), challenge, signature), VALID);
        assertEq(verifier.verify(_key(), T.digest(43113, address(0xbeef), T.hashSecurity(change)), signature), INVALID);
        assertEq(verifier.verify(_key(), T.digest(84532, address(0xcafe), T.hashSecurity(change)), signature), INVALID);
        T.CancelProposal memory cancellation;
        assertEq(
            verifier.verify(_key(), T.digest(84532, address(0xbeef), T.hashCancel(cancellation)), signature), INVALID
        );
        change.securityVersion++;
        assertEq(verifier.verify(_key(), T.digest(84532, address(0xbeef), T.hashSecurity(change)), signature), INVALID);
        change.securityVersion--;
        change.nonce++;
        assertEq(verifier.verify(_key(), T.digest(84532, address(0xbeef), T.hashSecurity(change)), signature), INVALID);
        // Stateless verification is intentionally repeatable: only the account consumes nonces.
        assertEq(verifier.verify(_key(), challenge, signature), VALID);
    }

    function testFuzz_arbitraryAbiCannotPanic(bytes calldata signature) public view {
        bytes4 result = verifier.verify(_key(), bytes32(0), signature);
        assertTrue(result == VALID || result == INVALID);
    }

    function _key() private pure returns (bytes memory) {
        return _key(TEST_SCALAR, RP_HASH, sha256(bytes(ORIGIN)));
    }

    function _key(uint256 scalar, bytes32 rp, bytes32 origin) private pure returns (bytes memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(scalar);
        return abi.encodePacked(rp, origin, bytes32(x), bytes32(y));
    }

    function _auth(uint256 scalar, bytes32 challenge, bytes32 rp, bytes1 flags, string memory origin)
        private
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        auth.authenticatorData = abi.encodePacked(rp, flags, bytes4(0));
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            origin,
            '","crossOrigin":false}'
        );
        auth.typeIndex = 1;
        auth.challengeIndex = 23;
        return _resign(scalar, auth);
    }

    function _resign(uint256 scalar, WebAuthn.WebAuthnAuth memory auth)
        private
        pure
        returns (WebAuthn.WebAuthnAuth memory)
    {
        (auth.r, auth.s) = vm.signP256(
            scalar, sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))))
        );
        if (uint256(auth.s) > P256.N / 2) auth.s = bytes32(P256.N - uint256(auth.s));
        return auth;
    }

    function _encode(WebAuthn.WebAuthnAuth memory auth) private pure returns (bytes memory) {
        return
            abi.encode(auth.r, auth.s, auth.challengeIndex, auth.typeIndex, auth.authenticatorData, auth.clientDataJSON);
    }
}
