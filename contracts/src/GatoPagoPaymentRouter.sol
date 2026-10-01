// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title GatoPagoPaymentRouter
 * @notice Non-custodial USDC checkout rail for external wallets paying a merchant
 *         on the same chain. The signed authorization describes the economic
 *         result: the merchant receives `settlementAmount` and the payer pays the
 *         separately disclosed `platformFee` on top.
 * @dev The contract is intentionally non-upgradeable and USDC-only. Deploy a new
 *      version instead of adding arbitrary token or route logic here.
 * @custom:security-contact https://github.com/danelerr/parmelia-links/security/advisories/new
 */
contract GatoPagoPaymentRouter is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct PaymentAuthorization {
        bytes32 intentId;
        bytes32 attemptId;
        address payer;
        address merchant;
        uint256 settlementAmount;
        uint256 platformFee;
        uint48 validAfter;
        uint48 validUntil;
        bytes32 metadataHash;
    }

    uint256 public constant MAX_PLATFORM_FEE_BPS = 100;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    bytes32 public constant PAYMENT_AUTHORIZATION_TYPEHASH = keccak256(
        "PaymentAuthorization(bytes32 intentId,bytes32 attemptId,address payer,address merchant,uint256 settlementAmount,uint256 platformFee,uint48 validAfter,uint48 validUntil,bytes32 metadataHash)"
    );

    IERC20 public immutable USDC;

    address public treasury;
    address public authorizationSigner;
    address public pauseGuardian;

    mapping(bytes32 attemptId => bool used) public usedAttempt;
    mapping(bytes32 intentId => bool paid) public paidIntent;

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event AuthorizationSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event PauseGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event PaymentSettled(
        bytes32 indexed intentId,
        bytes32 indexed attemptId,
        address indexed payer,
        address merchant,
        uint256 settlementAmount,
        uint256 platformFee,
        bytes32 metadataHash
    );
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);

    error GatoPagoPaymentRouter__InvalidToken();
    error GatoPagoPaymentRouter__InvalidTreasury();
    error GatoPagoPaymentRouter__InvalidAuthorizationSigner();
    error GatoPagoPaymentRouter__InvalidPauseGuardian();
    error GatoPagoPaymentRouter__InvalidIntentId();
    error GatoPagoPaymentRouter__InvalidAttemptId();
    error GatoPagoPaymentRouter__InvalidPayer();
    error GatoPagoPaymentRouter__InvalidMerchant();
    error GatoPagoPaymentRouter__InvalidAmount();
    error GatoPagoPaymentRouter__InvalidAuthorizationWindow();
    error GatoPagoPaymentRouter__AuthorizationNotActive(uint48 validAfter);
    error GatoPagoPaymentRouter__AuthorizationExpired(uint48 validUntil);
    error GatoPagoPaymentRouter__UnauthorizedPayer(address caller, address payer);
    error GatoPagoPaymentRouter__PlatformFeeTooHigh(uint256 fee, uint256 maximum);
    error GatoPagoPaymentRouter__AttemptAlreadyUsed(bytes32 attemptId);
    error GatoPagoPaymentRouter__IntentAlreadyPaid(bytes32 intentId);
    error GatoPagoPaymentRouter__InvalidAuthorization();
    error GatoPagoPaymentRouter__UnauthorizedPause(address caller);
    error GatoPagoPaymentRouter__InvalidRescueRecipient();

    constructor(
        address initialOwner,
        IERC20 usdc,
        address initialTreasury,
        address initialAuthorizationSigner,
        address initialPauseGuardian
    ) EIP712("GatoPago Payment Router", "2") Ownable(initialOwner) {
        if (address(usdc).code.length == 0) revert GatoPagoPaymentRouter__InvalidToken();
        if (initialTreasury == address(0)) revert GatoPagoPaymentRouter__InvalidTreasury();
        if (initialAuthorizationSigner == address(0)) {
            revert GatoPagoPaymentRouter__InvalidAuthorizationSigner();
        }
        if (initialPauseGuardian == address(0)) revert GatoPagoPaymentRouter__InvalidPauseGuardian();

        USDC = usdc;
        treasury = initialTreasury;
        authorizationSigner = initialAuthorizationSigner;
        pauseGuardian = initialPauseGuardian;

        emit TreasuryUpdated(address(0), initialTreasury);
        emit AuthorizationSignerUpdated(address(0), initialAuthorizationSigner);
        emit PauseGuardianUpdated(address(0), initialPauseGuardian);
    }

    /*//////////////////////////////////////////////////////////////
                         USER-FACING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pays an authorized checkout attempt using an existing USDC allowance.
    function pay(PaymentAuthorization calldata authorization, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        _settle(authorization, signature);
    }

    /// @notice Attempts an EIP-2612 permit before settling the checkout attempt.
    /// @dev A failed permit is tolerated to remain safe when its nonce was consumed
    ///      by a third party; settlement still requires sufficient allowance.
    function payWithPermit(
        PaymentAuthorization calldata authorization,
        bytes calldata signature,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        uint256 totalPayerAmount = authorization.settlementAmount + authorization.platformFee;
        try IERC20Permit(address(USDC)).permit(msg.sender, address(this), totalPayerAmount, permitDeadline, v, r, s) {}
            catch {}
        _settle(authorization, signature);
    }

    /*//////////////////////////////////////////////////////////////
                         ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert GatoPagoPaymentRouter__InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setAuthorizationSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert GatoPagoPaymentRouter__InvalidAuthorizationSigner();
        emit AuthorizationSignerUpdated(authorizationSigner, newSigner);
        authorizationSigner = newSigner;
    }

    function setPauseGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert GatoPagoPaymentRouter__InvalidPauseGuardian();
        emit PauseGuardianUpdated(pauseGuardian, newGuardian);
        pauseGuardian = newGuardian;
    }

    /// @notice Owner or operational guardian may stop new payments.
    function pause() external {
        if (msg.sender != owner() && msg.sender != pauseGuardian) {
            revert GatoPagoPaymentRouter__UnauthorizedPause(msg.sender);
        }
        _pause();
    }

    /// @notice Only the cold owner may resume payments.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recovers tokens transferred directly to the router by mistake.
    function rescueToken(IERC20 token, address recipient, uint256 amount) external onlyOwner {
        if (address(token).code.length == 0) revert GatoPagoPaymentRouter__InvalidToken();
        if (recipient == address(0)) revert GatoPagoPaymentRouter__InvalidRescueRecipient();
        token.safeTransfer(recipient, amount);
        emit TokenRescued(address(token), recipient, amount);
    }

    /*//////////////////////////////////////////////////////////////
                         READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the EIP-712 digest that the authorization signer approves.
    function authorizationDigest(PaymentAuthorization calldata authorization) external view returns (bytes32 digest) {
        digest = _authorizationDigest(authorization);
    }

    /// @notice Returns the chain-independent struct hash used by EIP-712.
    /// @dev Exposed so backend/client fixtures can detect any encoding drift
    ///      before an authorization capable of moving funds is issued.
    function authorizationStructHash(PaymentAuthorization calldata authorization)
        external
        pure
        returns (bytes32 structHash)
    {
        structHash = _authorizationStructHash(authorization);
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _settle(PaymentAuthorization calldata authorization, bytes calldata signature) private {
        _validateAuthorization(authorization, signature);

        usedAttempt[authorization.attemptId] = true;
        paidIntent[authorization.intentId] = true;

        USDC.safeTransferFrom(msg.sender, authorization.merchant, authorization.settlementAmount);
        if (authorization.platformFee > 0) {
            USDC.safeTransferFrom(msg.sender, treasury, authorization.platformFee);
        }

        emit PaymentSettled(
            authorization.intentId,
            authorization.attemptId,
            authorization.payer,
            authorization.merchant,
            authorization.settlementAmount,
            authorization.platformFee,
            authorization.metadataHash
        );
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _validateAuthorization(PaymentAuthorization calldata authorization, bytes calldata signature)
        private
        view
    {
        if (authorization.intentId == bytes32(0)) revert GatoPagoPaymentRouter__InvalidIntentId();
        if (authorization.attemptId == bytes32(0)) revert GatoPagoPaymentRouter__InvalidAttemptId();
        if (authorization.payer == address(0)) revert GatoPagoPaymentRouter__InvalidPayer();
        if (authorization.merchant == address(0)) revert GatoPagoPaymentRouter__InvalidMerchant();
        if (authorization.settlementAmount == 0) revert GatoPagoPaymentRouter__InvalidAmount();
        if (authorization.validUntil == 0 || authorization.validAfter > authorization.validUntil) {
            revert GatoPagoPaymentRouter__InvalidAuthorizationWindow();
        }
        if (msg.sender != authorization.payer) {
            revert GatoPagoPaymentRouter__UnauthorizedPayer(msg.sender, authorization.payer);
        }
        // Signed authorization windows are deliberately enforced against chain time.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < authorization.validAfter) {
            revert GatoPagoPaymentRouter__AuthorizationNotActive(authorization.validAfter);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > authorization.validUntil) {
            revert GatoPagoPaymentRouter__AuthorizationExpired(authorization.validUntil);
        }

        uint256 maximumPlatformFee = Math.mulDiv(authorization.settlementAmount, MAX_PLATFORM_FEE_BPS, BPS_DENOMINATOR);
        if (authorization.platformFee > maximumPlatformFee) {
            revert GatoPagoPaymentRouter__PlatformFeeTooHigh(authorization.platformFee, maximumPlatformFee);
        }
        if (usedAttempt[authorization.attemptId]) {
            revert GatoPagoPaymentRouter__AttemptAlreadyUsed(authorization.attemptId);
        }
        if (paidIntent[authorization.intentId]) {
            revert GatoPagoPaymentRouter__IntentAlreadyPaid(authorization.intentId);
        }

        (address recovered, ECDSA.RecoverError error, bytes32 errorArgument) =
            ECDSA.tryRecoverCalldata(_authorizationDigest(authorization), signature);
        if (error != ECDSA.RecoverError.NoError || errorArgument != bytes32(0) || recovered != authorizationSigner) {
            revert GatoPagoPaymentRouter__InvalidAuthorization();
        }
    }

    function _authorizationDigest(PaymentAuthorization calldata authorization) private view returns (bytes32 digest) {
        digest = _hashTypedDataV4(_authorizationStructHash(authorization));
    }

    function _authorizationStructHash(PaymentAuthorization calldata authorization)
        private
        pure
        returns (bytes32 structHash)
    {
        // forge-lint: disable-next-line(asm-keccak256)
        structHash = keccak256(
            abi.encode(
                PAYMENT_AUTHORIZATION_TYPEHASH,
                authorization.intentId,
                authorization.attemptId,
                authorization.payer,
                authorization.merchant,
                authorization.settlementAmount,
                authorization.platformFee,
                authorization.validAfter,
                authorization.validUntil,
                authorization.metadataHash
            )
        );
    }
}
