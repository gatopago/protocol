// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IAccount} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ERC721Holder, IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AccountV3Execution} from "src/v3/AccountV3Execution.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";

/// @notice V3 contract signatures, token receivers and introspection; composed with typed UUPS in AccountV3.
/// @dev ERC-1271 uses an explicit AccountSignature envelope, never raw owner signatures or ERC-7739.
/// Signature validity can change with security state. Read access is not spend authority.
/// Native receiving is inherited from OZ Account; ERC-20 requires no receiver callback.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
abstract contract AccountV3Interop is AccountV3Execution, IERC1271, IERC5267, ERC721Holder, ERC1155Holder {
    constructor(address ep) AccountV3Execution(ep) {}

    function isValidSignature(bytes32 hash, bytes calldata signature) public view returns (bytes4) {
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC1271).interfaceId || interfaceId == type(IERC5267).interfaceId
            || interfaceId == type(IAccount).interfaceId || interfaceId == type(IERC721Receiver).interfaceId
            || super.supportsInterface(interfaceId);
    }

    /// @dev Mirrors T.digest, including proxy context and current chain. No additional storage.
    /// OZ EIP712's non-upgradeable base has ordinary fallback string slots; this namespace-only
    /// account instead implements its interface using the same immutable protocol constants.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", T.DOMAIN_NAME, T.DOMAIN_VERSION, block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view override returns (bool) {
        _checkSecurityModule();
        return Security.verifyAccountSignature(hash, signature);
    }
}
