// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {
    ERC7579Utils,
    ModeSelector,
    ModePayload,
    Mode
} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {
    ERC7913WebAuthnVerifier
} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";
import {GatoPagoAccount} from "../../src/wallet/GatoPagoAccount.sol";
import {GatoPagoAccountFactory} from "../../src/wallet/GatoPagoAccountFactory.sol";
import {GatoPagoPaymaster} from "../../src/wallet/GatoPagoPaymaster.sol";

/// @dev The real EntryPoint v0.9, wallet contracts and helpers that build, sponsor and sign
/// UserOperations exactly as the SDK and a browser passkey do.
abstract contract WalletFixture is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 300_000;

    IEntryPoint internal ep;
    ERC7913WebAuthnVerifier internal verifier;
    GatoPagoAccountFactory internal factory;
    GatoPagoPaymaster internal paymaster;
    ERC20Mock internal usdc;
    uint256 internal sponsorKey;
    address internal bundler = makeAddr("bundler");
    address internal merchant = makeAddr("merchant");

    function _deployWallet() internal {
        deployCodeTo("EntryPoint.sol:EntryPoint", address(ERC4337Utils.ENTRYPOINT_V09)); // compiled via the import above
        ep = IEntryPoint(address(ERC4337Utils.ENTRYPOINT_V09));
        verifier = new ERC7913WebAuthnVerifier();
        factory = new GatoPagoAccountFactory();
        address sponsor;
        (sponsor, sponsorKey) = makeAddrAndKey("sponsor");
        paymaster = new GatoPagoPaymaster(sponsor, address(this));
        paymaster.deposit{value: 100 ether}();
        usdc = new ERC20Mock();
    }

    function _deployed(uint256 passkey) internal returns (address) {
        return factory.createAccount(_owners(passkey), 0);
    }

    function _owners(uint256 passkey) internal view returns (bytes[] memory owners) {
        (uint256 x, uint256 y) = vm.publicKeyP256(passkey);
        owners = new bytes[](1);
        owners[0] = abi.encodePacked(address(verifier), x, y);
    }

    function _initCode(bytes[] memory owners) internal view returns (bytes memory) {
        return abi.encodePacked(address(factory), abi.encodeCall(GatoPagoAccountFactory.createAccount, (owners, 0)));
    }

    /// @dev Chain-independent owner approval of `call` as the account's approval number `sequence`.
    function _approval(address account, uint256 passkey, uint256 sequence, bytes memory call)
        internal
        view
        returns (bytes memory)
    {
        return _passkeySignature(passkey, GatoPagoAccount(payable(account)).approvalHash(sequence, call));
    }

    function _approvalOp(
        address account,
        bytes memory initCode,
        uint256 sequence,
        bytes memory call,
        bytes memory approval
    ) internal view returns (PackedUserOperation memory op) {
        uint192 key = GatoPagoAccount(payable(factory.implementation())).REPLAYABLE_NONCE_KEY();
        op = _op(
            account,
            initCode,
            abi.encodeCall(GatoPagoAccount.applyApproval, (sequence, call)),
            ep.getNonce(account, key)
        );
        op.signature = approval;
    }

    function _transfer(address to, uint256 amount) internal view returns (bytes memory) {
        return _batch(address(usdc), 0, abi.encodeCall(usdc.transfer, (to, amount)));
    }

    function _batch(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(target, value, data);
        return _batch(calls);
    }

    /// @dev ERC-7821 `execute` of a batch, as the SDK encodes calls.
    function _batch(Execution[] memory calls) internal pure returns (bytes memory) {
        bytes32 mode = Mode.unwrap(
            ERC7579Utils.encodeMode(
                ERC7579Utils.CALLTYPE_BATCH,
                ERC7579Utils.EXECTYPE_DEFAULT,
                ModeSelector.wrap(0x00000000),
                ModePayload.wrap(0x00)
            )
        );
        return abi.encodeWithSignature("execute(bytes32,bytes)", mode, ERC7579Utils.encodeBatch(calls));
    }

    /// @dev Sponsored operation on the current network; the account signature is added afterwards.
    function _op(address account, bytes memory initCode, bytes memory callData, uint256 nonce)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = account;
        op.nonce = nonce;
        op.initCode = initCode;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | 500_000);
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 1 gwei);
        op.paymasterAndData = _sponsored(op, sponsorKey);
    }

    function _sponsored(PackedUserOperation memory op, uint256 signerKey) internal view returns (bytes memory) {
        uint48 validUntil = uint48(block.timestamp + 300);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "UserOperationRequest(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint256 paymasterVerificationGasLimit,uint256 paymasterPostOpGasLimit,uint48 validAfter,uint48 validUntil)"
                ),
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                uint256(PAYMASTER_VERIFICATION_GAS),
                uint256(0),
                uint48(0),
                validUntil
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("GatoPagoPaymaster"),
                keccak256("1"),
                block.chainid,
                address(paymaster)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return
            abi.encodePacked(address(paymaster), PAYMASTER_VERIFICATION_GAS, uint128(0), uint48(0), validUntil, r, s, v);
    }

    function _signed(PackedUserOperation memory op, uint256 passkey)
        internal
        view
        returns (PackedUserOperation memory)
    {
        op.signature = _passkeySignature(passkey, ep.getUserOpHash(op));
        return op;
    }

    /// @dev Same bytes a browser passkey produces for `navigator.credentials.get`.
    function _passkeySignature(uint256 passkey, bytes32 challenge) internal view returns (bytes memory) {
        bytes memory authenticatorData = abi.encodePacked(sha256("gatopago.com"), bytes1(0x05), uint32(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://gatopago.com","crossOrigin":false}'
        );
        bytes32 digest = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(passkey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));

        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encode(r, s, uint256(23), uint256(1), authenticatorData, clientDataJSON);
        return abi.encode(_owners(passkey), signatures);
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    function _send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, payable(bundler));
    }
}
