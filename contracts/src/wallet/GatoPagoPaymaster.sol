// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PaymasterSigner} from "@openzeppelin/contracts/account/paymaster/extensions/PaymasterSigner.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignerECDSA} from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";

/// @notice Verifying paymaster: sponsors a UserOperation when the backend's sponsor key
/// signed it (`paymasterData = validAfter ‖ validUntil ‖ signature`). Budgets live off-chain.
///
/// The EntryPoint pays whoever includes a sponsored operation from this deposit, at the operation's
/// own gas limits and prices, and the sponsor's signature cannot name who that is. So only GatoPago's
/// bundler, whose `relayer` sends the transaction (`tx.origin`), may use a sponsorship: nobody else
/// can include one first, or profit from its limits. ERC-7562 keeps public bundlers from reading
/// `tx.origin`; this paymaster only serves GatoPago's own.
contract GatoPagoPaymaster is PaymasterSigner, SignerECDSA, Ownable {
    address public relayer;

    event RelayerUpdated(address indexed relayer);

    error GatoPagoPaymaster__InvalidRelayer();

    constructor(address sponsorSigner, address relayer_, address owner)
        EIP712("GatoPagoPaymaster", "1")
        SignerECDSA(sponsorSigner)
        Ownable(owner)
    {
        _setRelayer(relayer_);
    }

    function setSponsorSigner(address sponsorSigner) external onlyOwner {
        _setSigner(sponsorSigner);
    }

    function setRelayer(address relayer_) external onlyOwner {
        _setRelayer(relayer_);
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

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 requiredPreFund)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        // slither-disable-next-line tx-origin (who sends the bundle, not who authorizes: see above)
        if (tx.origin != relayer) return ("", ERC4337Utils.SIG_VALIDATION_FAILED);
        return super._validatePaymasterUserOp(userOp, userOpHash, requiredPreFund);
    }

    function _setRelayer(address relayer_) private {
        if (relayer_ == address(0)) revert GatoPagoPaymaster__InvalidRelayer();
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }
}
