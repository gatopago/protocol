// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";

/// @dev External test action. The account executes it through its REAL signed CALL path.
contract V3EntryPointActionProbe {
    mapping(address account => uint256 count) public acknowledgements;
    error ProbeExecutionFailed();

    function acknowledge(bool shouldFail) external {
        if (shouldFail) revert ProbeExecutionFailed();
        ++acknowledgements[msg.sender];
    }
}

/// @dev Full production validation/execution/UUPS; only extra observation views. No auth overrides.
contract V3EntryPointValidationHarness is AccountV3 {
    V3EntryPointActionProbe public immutable actionProbe = new V3EntryPointActionProbe();

    constructor(address ep) AccountV3(ep) {}

    function acknowledgements() external view returns (uint256) {
        return actionProbe.acknowledgements(address(this));
    }

    function creationWindow() external view returns (uint256) {
        return Validity.creationData();
    }
}
