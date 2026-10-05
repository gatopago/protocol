// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice The part of Circle's CCTP V2 TokenMessenger that GatoPago uses.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
