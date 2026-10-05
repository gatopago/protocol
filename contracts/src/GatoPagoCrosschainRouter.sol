// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

/**
 * @title GatoPagoCrosschainRouter
 * @notice Flow B (outbound) of GatoPago cross-chain: a GatoPago smart account sends
 *         USDC from Arbitrum to another CCTP chain in a single atomic call. The
 *         router skims the GatoPago fee to the treasury and burns the net via CCTP
 *         v2 (`depositForBurn`). It never custodies funds across transactions.
 *
 *         Why a router (vs. the account batching the calls itself): it enforces a
 *         hard fee cap on-chain (protects the user from a backend bug overcharging)
 *         and emits one `opId`-indexed event so the relayer can reconcile the burn
 *         to a GatoPago operation deterministically. See docs/design/cross-chain.md.
 *
 *         v1 is USDC-only and always passes `destinationCaller = bytes32(0)` so
 *         `receiveMessage` on the destination stays permissionless (anyone, incl.
 *         the user, can complete the mint - a burn can never be stranded).
 * @custom:security-contact https://github.com/danelerr/parmelia-links/security/advisories/new
 */
contract GatoPagoCrosschainRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on the GatoPago fee, enforced regardless of the input.
    uint256 public constant MAX_FEE_BPS = 100; // 1%
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint32 public constant FAST_FINALITY = 1000;
    uint32 public constant STANDARD_FINALITY = 2000;
    /// @dev v1: keep receiveMessage permissionless (enables manual_complete).
    bytes32 private constant ANY_CALLER = bytes32(0);

    IERC20 public immutable USDC;
    ITokenMessengerV2 public immutable TOKEN_MESSENGER;
    address public treasury;

    // A third party must not be able to consume another payer's operation id.
    mapping(address sender => mapping(bytes32 opId => bool used)) public usedOpId;
    mapping(uint32 domain => bool supported) public supportedDestinationDomain;

    error InvalidToken();
    error InvalidMessenger();
    error InvalidTreasury();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidOpId();
    error OpIdAlreadyUsed(bytes32 opId);
    error EmptyDestinationDomainList();
    error UnsupportedDestinationDomain(uint32 domain);
    error InvalidFinalityThreshold(uint32 threshold);
    error MaxCctpFeeTooHigh(uint256 maxFee, uint256 burnAmount);
    error FeeTooHigh(uint256 fee, uint256 maxAllowed);

    event TreasuryUpdated(address indexed previous, address indexed current);
    event DestinationDomainSupportUpdated(uint32 indexed domain, bool supported);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event CrosschainSent(
        bytes32 indexed opId,
        address indexed sender,
        uint32 indexed destinationDomain,
        bytes32 mintRecipient,
        uint256 amountIn,
        uint256 gatoPagoFee,
        uint256 amountBurned,
        uint256 maxFee,
        uint32 minFinalityThreshold
    );

    constructor(
        address initialOwner,
        IERC20 usdc,
        ITokenMessengerV2 messenger,
        address initialTreasury,
        uint32[] memory initialDestinationDomains
    ) Ownable(initialOwner) {
        if (address(usdc).code.length == 0) revert InvalidToken();
        if (address(messenger).code.length == 0) revert InvalidMessenger();
        if (initialTreasury == address(0)) revert InvalidTreasury();
        if (initialDestinationDomains.length == 0) revert EmptyDestinationDomainList();
        USDC = usdc;
        TOKEN_MESSENGER = messenger;
        treasury = initialTreasury;
        emit TreasuryUpdated(address(0), initialTreasury);

        for (uint256 i; i < initialDestinationDomains.length; ++i) {
            _setDestinationDomain(initialDestinationDomains[i], true);
        }
    }

    // ─── Owner administration ─────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Enables or disables a Circle destination domain.
    function setDestinationDomain(uint32 domain, bool supported) external onlyOwner {
        _setDestinationDomain(domain, supported);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent here by mistake (the router holds no funds between txs).
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert InvalidToken();
        if (to == address(0)) revert InvalidTreasury();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    // ─── Core ─────────────────────────────────────────────────────────────────

    /**
     * @notice Skim the GatoPago fee and burn the net USDC to `mintRecipient` on
     *         `destinationDomain` via CCTP v2. The caller (the user's smart account)
     *         must have approved this router for `amount` of USDC.
     * @param opId GatoPago operation id, echoed in the event for reconciliation.
     * @param amount Gross USDC pulled from the caller (atomic units).
     * @param fee GatoPago fee (<= amount * MAX_FEE_BPS); sent to the treasury.
     * @param destinationDomain CCTP domain of the destination chain.
     * @param mintRecipient Recipient on the destination (bytes32-encoded address).
     * @param maxFee Max CCTP fee accepted for a Fast transfer (atomic units).
     * @param minFinalityThreshold 1000 = Fast, 2000 = Standard (CCTP semantics).
     */
    // USDC capitalization is part of the deployed public ABI.
    // forge-lint: disable-next-line(mixed-case-function)
    function bridgeUSDC(
        bytes32 opId,
        uint256 amount,
        uint256 fee,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external nonReentrant whenNotPaused {
        // opId keys the off-chain reconciliation of this burn; a zero id would
        // produce an unattributable CrosschainSent event.
        if (opId == bytes32(0)) revert InvalidOpId();
        if (amount == 0) revert InvalidAmount();
        if (mintRecipient == bytes32(0)) revert InvalidRecipient();
        if (!supportedDestinationDomain[destinationDomain]) {
            revert UnsupportedDestinationDomain(destinationDomain);
        }
        if (minFinalityThreshold != FAST_FINALITY && minFinalityThreshold != STANDARD_FINALITY) {
            revert InvalidFinalityThreshold(minFinalityThreshold);
        }
        if (usedOpId[msg.sender][opId]) revert OpIdAlreadyUsed(opId);

        uint256 maxAllowed = Math.mulDiv(amount, MAX_FEE_BPS, BPS_DENOMINATOR);
        if (fee > maxAllowed) revert FeeTooHigh(fee, maxAllowed);

        uint256 net = amount - fee;
        if (maxFee >= net) revert MaxCctpFeeTooHigh(maxFee, net);

        usedOpId[msg.sender][opId] = true;

        // Effects/interactions: pull fee + net, then burn the net via CCTP.
        if (fee > 0) USDC.safeTransferFrom(msg.sender, treasury, fee);
        USDC.safeTransferFrom(msg.sender, address(this), net);
        USDC.forceApprove(address(TOKEN_MESSENGER), net);
        TOKEN_MESSENGER.depositForBurn(
            net, destinationDomain, mintRecipient, address(USDC), ANY_CALLER, maxFee, minFinalityThreshold
        );
        // Do not leave spend authority with an external messenger after this operation.
        USDC.forceApprove(address(TOKEN_MESSENGER), 0);

        emit CrosschainSent(
            opId, msg.sender, destinationDomain, mintRecipient, amount, fee, net, maxFee, minFinalityThreshold
        );
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _setDestinationDomain(uint32 domain, bool supported) private {
        supportedDestinationDomain[domain] = supported;
        emit DestinationDomainSupportUpdated(domain, supported);
    }
}
