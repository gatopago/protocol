// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Candidate V3 proxy. The factory MUST initialize it in the same transaction.
/// @dev No variable policy/proof in creation code. No admin, beacon or upgrade entry point here.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
contract AccountV3Proxy is ERC1967Proxy {
    constructor(address implementation) ERC1967Proxy(implementation, bytes("")) {}

    receive() external payable {
        _fallback();
    }

    /// @dev Reserved non-delegated selector. A factory must not trust a getter supplied by an unknown implementation.
    function proxyImplementation() external view returns (address) {
        return _implementation();
    }

    /// @dev Only safe with atomic deployment+authenticated initialization. Direct deployment is NOT onboarding.
    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}
