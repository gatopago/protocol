// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

/**
 * @title GatoPagoPaymentRouter
 * @notice Pays a GatoPago Flow payment intent in USDC, as authorized by Flow's signer. The merchant
 *         receives `amount` on this network, or on another one through Circle CCTP V2, whose
 *         Forwarding Service mints on the destination. The payer also pays the platform `fee` and,
 *         when crossing networks, at most `maxCctpFee` (what Circle does not charge reaches the
 *         merchant). Non-custodial: funds only pass through within the payment transaction.
 */
contract GatoPagoPaymentRouter is EIP712, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    struct Payment {
        bytes32 intentId;
        address payer;
        address merchant;
        uint256 amount;
        uint256 fee;
        /// @dev Circle domain where the merchant receives; `LOCAL_DOMAIN` pays on this network.
        uint32 destinationDomain;
        uint256 maxCctpFee;
        uint32 minFinalityThreshold;
        uint48 validUntil;
    }

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 intentId,address payer,address merchant,uint256 amount,uint256 fee,uint32 destinationDomain,uint256 maxCctpFee,uint32 minFinalityThreshold,uint48 validUntil)"
    );
    /// @dev Circle's Forwarding Service request: "cctp-forward" as bytes24, version 0, no extra data.
    bytes private constant FORWARD_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    IERC20 public immutable USDC;
    ITokenMessengerV2 public immutable TOKEN_MESSENGER;
    uint32 public immutable LOCAL_DOMAIN;

    address public signer;
    address public treasury;
    mapping(bytes32 intentId => bool) public paid;

    event PaymentSent(
        bytes32 indexed intentId,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint256 fee,
        uint32 destinationDomain
    );
    event SignerUpdated(address indexed signer);
    event TreasuryUpdated(address indexed treasury);

    error GatoPagoPaymentRouter__InvalidAddress();
    error GatoPagoPaymentRouter__NotPayer();
    error GatoPagoPaymentRouter__Expired();
    error GatoPagoPaymentRouter__AlreadyPaid();
    error GatoPagoPaymentRouter__InvalidSignature();

    constructor(
        address owner_,
        address signer_,
        address treasury_,
        IERC20 usdc,
        ITokenMessengerV2 tokenMessenger,
        uint32 localDomain
    ) EIP712("GatoPago Payment Router", "3") Ownable(owner_) {
        if (signer_ == address(0) || treasury_ == address(0) || address(usdc) == address(0)) {
            revert GatoPagoPaymentRouter__InvalidAddress();
        }
        signer = signer_;
        treasury = treasury_;
        USDC = usdc;
        TOKEN_MESSENGER = tokenMessenger;
        LOCAL_DOMAIN = localDomain;
    }

    /// @notice Pays with an existing USDC allowance (a smart account approves in the same batch).
    function pay(Payment calldata payment, bytes calldata signature) external whenNotPaused {
        _pay(payment, signature);
    }

    /// @notice Pays in one transaction from a wallet that signs an EIP-2612 permit. A permit whose
    /// nonce a third party already used is ignored; the payment then needs the allowance.
    function payWithPermit(
        Payment calldata payment,
        bytes calldata signature,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        try IERC20Permit(address(USDC)).permit(msg.sender, address(this), total(payment), deadline, v, r, s) {} catch {}
        _pay(payment, signature);
    }

    /// @notice USDC the payer spends: amount, fee and, when crossing networks, the CCTP fee ceiling.
    function total(Payment calldata payment) public view returns (uint256) {
        return payment.amount + payment.fee + (payment.destinationDomain == LOCAL_DOMAIN ? 0 : payment.maxCctpFee);
    }

    function paymentDigest(Payment calldata payment) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPEHASH, payment)));
    }

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert GatoPagoPaymentRouter__InvalidAddress();
        signer = signer_;
        emit SignerUpdated(signer_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert GatoPagoPaymentRouter__InvalidAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _pay(Payment calldata payment, bytes calldata signature) private {
        if (msg.sender != payment.payer) revert GatoPagoPaymentRouter__NotPayer();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > payment.validUntil) revert GatoPagoPaymentRouter__Expired();
        if (paid[payment.intentId]) revert GatoPagoPaymentRouter__AlreadyPaid();
        if (ECDSA.recoverCalldata(paymentDigest(payment), signature) != signer) {
            revert GatoPagoPaymentRouter__InvalidSignature();
        }
        paid[payment.intentId] = true;
        emit PaymentSent(
            payment.intentId, payment.payer, payment.merchant, payment.amount, payment.fee, payment.destinationDomain
        );

        if (payment.fee != 0) USDC.safeTransferFrom(msg.sender, treasury, payment.fee);
        if (payment.destinationDomain == LOCAL_DOMAIN) {
            USDC.safeTransferFrom(msg.sender, payment.merchant, payment.amount);
        } else {
            uint256 burn = payment.amount + payment.maxCctpFee;
            USDC.safeTransferFrom(msg.sender, address(this), burn);
            USDC.forceApprove(address(TOKEN_MESSENGER), burn);
            TOKEN_MESSENGER.depositForBurnWithHook(
                burn,
                payment.destinationDomain,
                bytes32(uint256(uint160(payment.merchant))),
                address(USDC),
                bytes32(0),
                payment.maxCctpFee,
                payment.minFinalityThreshold,
                FORWARD_HOOK
            );
        }
    }
}
