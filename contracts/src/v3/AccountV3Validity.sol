// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";

/// @notice V3 half-open timestamp windows adapted to EntryPoint v0.9 without reading the clock.
/// @dev EntryPoint enforces after < now <= until. V3 signs after <= now < until.
/// Positive 47-bit timestamps exclude zero/infinity and v0.9 block-range flags. The initial
/// window is consumed ONLY during validateUserOp from the pinned EntryPoint; failed validation
/// reverts creation with handleOps. Existing accounts never infer creation from initCode presence.
library AccountV3Validity {
    uint48 internal constant MAX_TIMESTAMP = 0x7fffffffffff;

    error AccountV3Validity__InvalidWindow();

    function validationData(bool authorized, uint48 validAfter, uint48 validUntil) internal pure returns (uint256) {
        if (validAfter == 0 || validUntil <= validAfter || validUntil > MAX_TIMESTAMP) {
            revert AccountV3Validity__InvalidWindow();
        }
        return ERC4337Utils.packValidationData(authorized, validAfter - 1, validUntil - 1);
    }

    function recordCreation(uint48 validAfter, uint48 validUntil) internal {
        // Same validation as the public wire window, before packing persistent fields.
        validationData(true, validAfter, validUntil);
        D.Layout storage state = D.layout();
        state.creationValidAfter = validAfter;
        state.creationValidUntil = validUntil;
    }

    function consumeCreation(uint256 operationData) internal returns (uint256) {
        uint256 initialData = creationData();
        if (initialData == 0) return operationData;
        D.Layout storage state = D.layout();
        delete state.creationValidAfter;
        delete state.creationValidUntil;
        return ERC4337Utils.combineValidationData(operationData, initialData);
    }

    function creationData() internal view returns (uint256) {
        D.Layout storage state = D.layout();
        if (state.creationValidUntil == 0) return 0;
        return validationData(true, state.creationValidAfter, state.creationValidUntil);
    }
}
