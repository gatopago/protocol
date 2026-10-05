// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {MultiSignerERC7913} from "@openzeppelin/contracts/utils/cryptography/signers/MultiSignerERC7913.sol";

/// @notice GatoPago smart account: ERC-4337 (EntryPoint v0.9) with passkey owners, behind a UUPS proxy.
/// Any single owner (threshold 1) can spend and manage owners, so a passkey on a second device is the
/// recovery path. Owners are ERC-7913 signers: `abi.encodePacked(webAuthnVerifier, x, y)` for passkeys.
///
/// Two separate channels keep every network's owners and implementation in sync:
/// - Normal nonces: `execute` batches that never call the account itself (nor `address(0)`, which
///   ERC-7579 executes as the account). Signed over the chain-bound EntryPoint `userOpHash`.
/// - `REPLAYABLE_NONCE_KEY`: `applyApproval(sequence, call)` where `call` is one `addOwners`,
///   `removeOwners` or `upgradeToAndCall`. Owners sign `(sequence, call)` without the chain id, so one
///   approval applies on every network in sequence order, including networks where the account is
///   deployed later from its original owners. The sequence is the account's own and only advances when
///   the call succeeds: a failed or griefed attempt (low gas, reverting paymaster) leaves the approval
///   valid for a retry. Replays must be sponsored so they never spend account funds.
///   Pattern from Coinbase Smart Wallet (MIT), adapted to EntryPoint v0.9.
///
/// Storage: inherited contracts keep their declared order; GatoPago state lives in ERC-7201 namespaces.
contract GatoPagoAccount is
    Account,
    EIP712,
    ERC7739,
    ERC7821,
    MultiSignerERC7913,
    ERC721Holder,
    ERC1155Holder,
    Initializable,
    UUPSUpgradeable
{
    uint192 public constant REPLAYABLE_NONCE_KEY = 0x4761746f5061676f; // "GatoPago"

    bytes32 private constant APPROVAL_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,address verifyingContract)");
    bytes32 private constant APPROVAL_TYPEHASH = keccak256("Approval(uint256 sequence,bytes call)");

    /// @dev ERC-7201 slot of `gatopago.storage.ApprovalSequence` (`cast index-erc7201`).
    bytes32 private constant APPROVAL_SEQUENCE_SLOT =
        0x51d7185701a1af8ad4fac1160c0c9aeb5b7e433ce89846477d0377fef9edec00;

    error GatoPagoAccountApprovalOutOfOrder(uint256 expected, uint256 provided);

    /// @dev The implementation keeps an unusable owner and is never initialized.
    constructor() EIP712("GatoPagoAccount", "1") MultiSignerERC7913(_unusableOwner(), 1) {
        _disableInitializers();
    }

    function initialize(bytes[] calldata owners) external initializer {
        _addSigners(owners);
        _setThreshold(1);
    }

    function addOwners(bytes[] calldata owners) external onlyEntryPointOrSelf {
        _addSigners(owners);
    }

    /// @dev Reverts if it would leave the account without owners.
    function removeOwners(bytes[] calldata owners) external onlyEntryPointOrSelf {
        _removeSigners(owners);
    }

    /// @notice Applies the next owner approval. Reverts (keeping the sequence) if `call` fails.
    function applyApproval(uint256 sequence, bytes calldata call) external onlyEntryPoint {
        StorageSlot.Uint256Slot storage next = StorageSlot.getUint256Slot(APPROVAL_SEQUENCE_SLOT);
        require(sequence == next.value, GatoPagoAccountApprovalOutOfOrder(next.value, sequence));
        next.value = sequence + 1;
        // slither-disable-next-line unused-return (reverts on failure; the result is not needed)
        Address.functionCall(address(this), call);
    }

    /// @notice Sequence of the next approval this account will accept on this network.
    function approvalSequence() public view returns (uint256) {
        return StorageSlot.getUint256Slot(APPROVAL_SEQUENCE_SLOT).value;
    }

    /// @notice Hash the owners sign for an approval (EIP-712 without chain id).
    function approvalHash(uint256 sequence, bytes calldata call) external view returns (bytes32) {
        return _approvalHash(sequence, call);
    }

    function _approvalHash(uint256 sequence, bytes memory call) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(APPROVAL_DOMAIN_TYPEHASH, keccak256("GatoPagoAccount"), keccak256("1"), address(this))
        );
        bytes32 approval = keccak256(abi.encode(APPROVAL_TYPEHASH, sequence, keccak256(call)));
        return keccak256(abi.encodePacked(hex"1901", domain, approval));
    }

    function _validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, bytes calldata signature)
        internal
        override
        returns (uint256)
    {
        bool allowed = _isReplayable(userOp.nonce)
            ? userOp.paymasterAndData.length != 0 && _isNextApproval(userOp.callData)
            : _isSpendCall(userOp.callData);
        return allowed ? super._validateUserOp(userOp, userOpHash, signature) : ERC4337Utils.SIG_VALIDATION_FAILED;
    }

    function _signableUserOpHash(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (bytes32)
    {
        if (!_isReplayable(userOp.nonce)) return userOpHash;
        (uint256 sequence, bytes memory call) = abi.decode(userOp.callData[4:], (uint256, bytes));
        return _approvalHash(sequence, call);
    }

    // slither-disable-next-line dead-code (called by ERC7821.execute)
    function _erc7821AuthorizedExecutor(address caller, bytes32 mode, bytes calldata executionData)
        internal
        view
        override
        returns (bool)
    {
        return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
    }

    function _authorizeUpgrade(address) internal override onlyEntryPointOrSelf {}

    function _isReplayable(uint256 nonce) private pure returns (bool) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint192(nonce >> 64) == REPLAYABLE_NONCE_KEY;
    }

    /// @dev `applyApproval(approvalSequence(), call)` with `call` to an owner or upgrade function.
    function _isNextApproval(bytes calldata callData) private view returns (bool) {
        // forge-lint: disable-next-line(unsafe-typecast)
        if (callData.length < 4 || bytes4(callData) != this.applyApproval.selector) return false;
        (uint256 sequence, bytes memory call) = abi.decode(callData[4:], (uint256, bytes));
        if (sequence != approvalSequence() || call.length < 4) return false;
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(call);
        return selector == this.addOwners.selector || selector == this.removeOwners.selector
            || selector == this.upgradeToAndCall.selector;
    }

    /// @dev Empty (deployment only) or an `execute` batch that never targets the account itself,
    /// so owners and implementation only change through approvals.
    function _isSpendCall(bytes calldata callData) private view returns (bool) {
        if (callData.length == 0) return true;
        // forge-lint: disable-next-line(unsafe-typecast)
        if (callData.length < 4 || bytes4(callData) != this.execute.selector) return false;
        (, bytes memory executionData) = abi.decode(callData[4:], (bytes32, bytes));
        Execution[] memory calls = abi.decode(executionData, (Execution[]));
        for (uint256 i = 0; i < calls.length; ++i) {
            if (calls[i].target == address(this) || calls[i].target == address(0)) return false;
        }
        return true;
    }

    function _unusableOwner() private pure returns (bytes[] memory owners) {
        owners = new bytes[](1);
        owners[0] = abi.encodePacked(address(0xdead));
    }
}
