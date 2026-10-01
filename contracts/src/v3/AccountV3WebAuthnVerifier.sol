// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {
    ERC7913WebAuthnVerifier
} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @notice Stateless V3 assertion verifier: SHA256(rpId) | SHA256(origin) | qx | qy.
 * @dev Uses W3C's limited clientDataJSON verification, with no cross-origin embedding.
 * The origin must be a canonical, unescaped ASCII serialized origin. Additional client
 * data fields are tolerated after the required prefix, not interpreted as authority.
 * OpenZeppelin owns P256 verification, UP/UV and BE/BS checks. There is no raw-P256 fallback.
 * This contract grants no account authority: Account V3 must bind the challenge to its
 * domain, purpose, nonce, security version and expiry and pin this verifier's codehash.
 * @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
 */
contract AccountV3WebAuthnVerifier is ERC7913WebAuthnVerifier {
    bytes4 private constant INVALID = 0xffffffff;
    uint256 private constant MAX_SIGNATURE_BYTES = 4096;
    uint256 private constant MAX_CLIENT_DATA_BYTES = 2048;
    uint256 private constant MAX_AUTHENTICATOR_DATA_BYTES = 1024;
    uint256 private constant MAX_ORIGIN_BYTES = 512;

    /*//////////////////////////////////////////////////////////////
                         USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc ERC7913WebAuthnVerifier
    function verify(bytes calldata key, bytes32 hash, bytes calldata signature) public view override returns (bytes4) {
        if (key.length != 128 || signature.length > MAX_SIGNATURE_BYTES) return INVALID;
        (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature);
        if (!decoded) return INVALID;
        // Bounds precede copying dynamic data or invoking P256. Fixed indexes also prevent
        // accepting a type/challenge hidden in a nested object or wrapped arithmetic index.
        if (
            auth.authenticatorData.length < 37 || auth.authenticatorData.length > MAX_AUTHENTICATOR_DATA_BYTES
                || bytes(auth.clientDataJSON).length > MAX_CLIENT_DATA_BYTES || auth.typeIndex != 1
                || auth.challengeIndex != 23
        ) return INVALID;
        if (bytes32(key[:32]) == bytes32(0) || bytes32(key[32:64]) == bytes32(0)) return INVALID;
        if (bytes32(auth.authenticatorData[:32]) != bytes32(key[:32])) return INVALID;
        if (!_boundClientData(bytes(auth.clientDataJSON), hash, bytes32(key[32:64]))) return INVALID;

        // Keep the dependency's assertion decoder and cryptographic validation; only the
        // first 64 descriptor bytes are V3-specific. V1/V2 64-byte keys are rejected above.
        return super.verify(key[64:], hash, signature);
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev W3C WebAuthn 3, section 5.8.1.2. This is deliberately not a general JSON parser.
    function _boundClientData(bytes calldata data, bytes32 hash, bytes32 originHash) private pure returns (bool) {
        bytes memory prefix = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(hash)), '","origin":"'
        );
        if (data.length <= prefix.length || keccak256(data[:prefix.length]) != keccak256(prefix)) return false;

        uint256 end = prefix.length;
        while (end < data.length && data[end] != 0x22) {
            // Serialized HTTP(S) origins are ASCII (IDNs use punycode). Never decode escapes
            // or normalize a URL onchain; the enrolled origin's exact bytes are committed.
            if (end - prefix.length >= MAX_ORIGIN_BYTES || data[end] < 0x21 || data[end] > 0x7e || data[end] == 0x5c) {
                return false;
            }
            ++end;
        }
        if (end == prefix.length || end == data.length || sha256(data[prefix.length:end]) != originHash) return false;

        bytes memory suffix = bytes('","crossOrigin":false');
        uint256 afterPrefix = end + suffix.length;
        if (data.length <= afterPrefix || keccak256(data[end:afterPrefix]) != keccak256(suffix)) return false;
        return data[afterPrefix] == 0x7d || data[afterPrefix] == 0x2c;
    }
}
