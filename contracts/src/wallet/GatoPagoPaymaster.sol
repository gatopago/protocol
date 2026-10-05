// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PaymasterSigner} from "@openzeppelin/contracts/account/paymaster/extensions/PaymasterSigner.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignerECDSA} from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";

/// @notice Verifying paymaster: sponsors a UserOperation when the backend's sponsor key
/// signed it (`paymasterData = validAfter ‖ validUntil ‖ signature`). Budgets live off-chain.
contract GatoPagoPaymaster is PaymasterSigner, SignerECDSA, Ownable {
    constructor(address sponsorSigner, address owner)
        EIP712("GatoPagoPaymaster", "1")
        SignerECDSA(sponsorSigner)
        Ownable(owner)
    {}

    function setSponsorSigner(address sponsorSigner) external onlyOwner {
        _setSigner(sponsorSigner);
    }

    function deposit() external payable {
        _deposit(msg.value);
    }

    function withdraw(address payable to, uint256 value) external onlyOwner {
        _withdraw(to, value);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        _addStake(msg.value, unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        _unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        _withdrawStake(to);
    }
}
