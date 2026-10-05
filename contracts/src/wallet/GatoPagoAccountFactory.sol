// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {GatoPagoAccount} from "./GatoPagoAccount.sol";

/// @notice Deterministic GatoPago accounts behind ERC-1967 (UUPS) proxies. The address commits to the
/// initial owners and the original implementation, so with the factory deployed at the same address on
/// every network a user has one address everywhere, even after upgrading on some of them.
contract GatoPagoAccountFactory {
    address public immutable implementation;

    constructor() {
        implementation = address(new GatoPagoAccount());
    }

    /// @dev Idempotent, so it can be used as ERC-4337 `initCode`.
    function createAccount(bytes[] calldata owners, uint256 salt) external returns (address account) {
        account = getAddress(owners, salt);
        if (account.code.length == 0) {
            new ERC1967Proxy{salt: bytes32(salt)}(implementation, _initialization(owners));
        }
    }

    function getAddress(bytes[] calldata owners, uint256 salt) public view returns (address) {
        bytes memory creationCode =
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, _initialization(owners)));
        return Create2.computeAddress(bytes32(salt), keccak256(creationCode));
    }

    function _initialization(bytes[] calldata owners) private pure returns (bytes memory) {
        return abi.encodeCall(GatoPagoAccount.initialize, (owners));
    }
}
