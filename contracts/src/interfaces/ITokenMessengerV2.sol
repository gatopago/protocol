// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Minimal Circle CCTP v2 TokenMessenger interface used by GatoPago.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}
