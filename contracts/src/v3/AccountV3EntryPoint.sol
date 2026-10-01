// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Account, PackedUserOperation, IEntryPoint} from "@openzeppelin/contracts/account/Account.sol";
import {AccountV3Initializable} from "src/v3/AccountV3Initializable.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";

/// @notice EntryPoint-bound creation/validation composition. Still abstract: no generic asset executor.
/// @dev OZ enforces onlyEntryPoint and pays prefund. Concrete V3 authorization must bind actual UserOp
/// hash (including gas/paymaster/callData), policy, nonce and operation window before returning data.
/// EntryPoint v0.9 reverts the entire handleOps on validation failure, including CREATE2 and prefund.
/// The creation window is consumed here, not by a relayer, admin, initCode flag or application request.
/// @custom:security-contact https://github.com/danelerr/parmelia-links/blob/main/SECURITY.md
abstract contract AccountV3EntryPoint is Account, AccountV3Initializable {
    error AccountV3EntryPoint__InvalidAccount();

    constructor(address entryPoint_) AccountV3Initializable(entryPoint_) {}

    function entryPoint() public view override returns (IEntryPoint) {
        return IEntryPoint(initializationEntryPoint());
    }

    function _validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, bytes calldata signature)
        internal
        override
        returns (uint256)
    {
        D.Layout storage state = D.layout();
        if (!state.initialized || state.generation != T.GENERATION || userOp.sender != address(this)) {
            revert AccountV3EntryPoint__InvalidAccount();
        }
        _checkSecurityModule();
        return Validity.consumeCreation(_validateAccountUserOp(userOp, userOpHash, signature));
    }

    function _validateAccountUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, bytes calldata signature)
        internal
        virtual
        returns (uint256);
}
