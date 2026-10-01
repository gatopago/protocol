// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {GatoPagoPaymaster} from "../src/GatoPagoPaymaster.sol";
import {IPaymaster, IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract MockPaymasterEntryPoint {
    mapping(address account => uint256 amount) public balanceOf;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "withdraw failed");
    }
}

contract GatoPagoPaymasterTest is Test {
    event SponsorSignerSet(address indexed previousSigner, address indexed newSigner);

    GatoPagoPaymaster internal paymaster;
    address internal constant ENTRY_POINT = address(0xEE);

    uint256 internal sponsorPk = 0xA11CE;
    address internal sponsor;

    uint128 internal constant VER_GAS = 100000;
    uint128 internal constant POSTOP_GAS = 50000;

    function setUp() public {
        sponsor = vm.addr(sponsorPk);
        vm.etch(ENTRY_POINT, hex"00");
        paymaster = new GatoPagoPaymaster(IEntryPoint(ENTRY_POINT), address(this));
        paymaster.setSponsorSigner(sponsor);
    }

    function _baseUserOp() internal pure returns (PackedUserOperation memory op) {
        op.sender = address(0xBEEF);
        op.nonce = 7;
        op.initCode = "";
        op.callData = hex"1234";
        op.accountGasLimits = bytes32(uint256(0x111));
        op.preVerificationGas = 100000;
        op.gasFees = bytes32(uint256(0x222));
        op.signature = "";
    }

    function _header() internal view returns (bytes memory) {
        return abi.encodePacked(address(paymaster), VER_GAS, POSTOP_GAS);
    }

    function _digest(PackedUserOperation memory op, uint48 validAfter, uint48 validUntil)
        internal
        view
        returns (bytes32)
    {
        bytes32 paymasterConfigHash = keccak256(_header());
        bytes memory encoded = abi.encode(
            block.chainid,
            address(paymaster),
            op.sender,
            op.nonce,
            keccak256(op.initCode),
            keccak256(op.callData),
            op.accountGasLimits,
            op.preVerificationGas,
            op.gasFees,
            paymasterConfigHash,
            uint256(validAfter),
            uint256(validUntil)
        );
        return keccak256(encoded);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sponsorPk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function _paymasterAndData(uint48 validAfter, uint48 validUntil, bytes memory sig)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(_header(), validAfter, validUntil, sig);
    }

    function test_validSponsorshipReturnsTimeBoundedValidationData() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, validAfter, validUntil));
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, sig);

        vm.prank(ENTRY_POINT);
        (bytes memory ctx, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);

        assertEq(ctx.length, 0);
        assertEq(validationData, ERC4337Utils.packValidationData(true, validAfter, validUntil));
    }

    function test_rejectsInfiniteAndInvertedWindows() public {
        PackedUserOperation memory op = _baseUserOp();
        op.paymasterAndData = _paymasterAndData(0, 0, new bytes(65));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(GatoPagoPaymaster.InvalidSponsorshipWindow.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        op.paymasterAndData = _paymasterAndData(10, 9, new bytes(65));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(GatoPagoPaymaster.InvalidSponsorshipWindow.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        op.paymasterAndData = _paymasterAndData(0, type(uint48).max, new bytes(65));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(GatoPagoPaymaster.InvalidSponsorshipWindow.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_rejectsForeignPaymasterHeader() public {
        PackedUserOperation memory op = _baseUserOp();
        op.paymasterAndData =
            abi.encodePacked(address(0xBAD), VER_GAS, POSTOP_GAS, uint48(0), uint48(100), new bytes(65));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(GatoPagoPaymaster.InvalidPaymasterHeader.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    // ERC-4337: signature mismatches must RETURN SIG_VALIDATION_FAILED
    // (authorizer = address(1)), not revert, so bundlers can tell a bad
    // signature apart from a broken paymaster.

    function test_tamperedTimeBoundsReturnSigValidationFailed() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, validAfter, validUntil));
        // Sign for validUntil, but ship a different validUntil in the bytes.
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil + 1, sig);

        vm.prank(ENTRY_POINT);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(validationData, ERC4337Utils.packValidationData(false, validAfter, validUntil + 1));
    }

    function test_wrongSignerReturnsSigValidationFailed() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xB0B, MessageHashUtils.toEthSignedMessageHash(_digest(op, validAfter, validUntil)));
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, abi.encodePacked(r, s, v));

        vm.prank(ENTRY_POINT);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(validationData, ERC4337Utils.packValidationData(false, validAfter, validUntil));
    }

    function test_malformedSignatureReturnsSigValidationFailed() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);
        PackedUserOperation memory op = _baseUserOp();
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, new bytes(64));

        vm.prank(ENTRY_POINT);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);

        assertEq(validationData, ERC4337Utils.packValidationData(false, validAfter, validUntil));
    }

    function test_maxSponsoredGasCostCapEnforced() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);

        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, validAfter, validUntil));
        op.paymasterAndData = _paymasterAndData(validAfter, validUntil, sig);

        paymaster.setMaxSponsoredGasCost(1 ether);

        // Under the cap: sponsored normally.
        vm.prank(ENTRY_POINT);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0.5 ether);
        assertEq(validationData, ERC4337Utils.packValidationData(true, validAfter, validUntil));

        // Over the cap: refused even with a perfectly valid sponsor signature.
        vm.prank(ENTRY_POINT);
        vm.expectRevert(
            abi.encodeWithSelector(GatoPagoPaymaster.MaxSponsoredGasCostExceeded.selector, 2 ether, 1 ether)
        );
        paymaster.validatePaymasterUserOp(op, bytes32(0), 2 ether);
    }

    function test_maxSponsoredGasCostOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        paymaster.setMaxSponsoredGasCost(1);
    }

    function test_constructor_rejectsZeroEntryPoint() public {
        vm.expectRevert(GatoPagoPaymaster.InvalidEntryPoint.selector);
        new GatoPagoPaymaster(IEntryPoint(address(0)), address(this));
    }

    function test_constructor_rejectsEntryPointWithoutCode() public {
        vm.expectRevert(GatoPagoPaymaster.InvalidEntryPoint.selector);
        new GatoPagoPaymaster(IEntryPoint(address(0xDEAD)), address(this));
    }

    function test_setSponsorSigner_rejectsZeroAndNonOwner() public {
        vm.expectRevert(GatoPagoPaymaster.InvalidSponsorSigner.selector);
        paymaster.setSponsorSigner(address(0));

        vm.prank(address(0xBAD));
        vm.expectRevert();
        paymaster.setSponsorSigner(address(0xCAFE));
    }

    function test_roleHandoffSeparatesSponsorSignerAndOwner() public {
        address newSponsorSigner = address(0x516E2);
        address newOwner = address(0xA11CE);

        vm.expectEmit(true, true, false, false, address(paymaster));
        emit SponsorSignerSet(sponsor, newSponsorSigner);
        paymaster.setSponsorSigner(newSponsorSigner);
        paymaster.transferOwnership(newOwner);

        assertEq(paymaster.owner(), address(this));
        assertEq(paymaster.pendingOwner(), newOwner);
        assertEq(paymaster.sponsorSigner(), newSponsorSigner);

        vm.prank(newOwner);
        paymaster.acceptOwnership();
        assertEq(paymaster.owner(), newOwner);
        assertEq(paymaster.pendingOwner(), address(0));
        assertEq(paymaster.sponsorSigner(), newSponsorSigner);

        vm.expectRevert();
        paymaster.setMaxSponsoredGasCost(1);
    }

    function test_missingSignatureReverts() public {
        PackedUserOperation memory op = _baseUserOp();
        // Only the header + time bounds, no signature.
        op.paymasterAndData = abi.encodePacked(_header(), uint48(0), uint48(block.timestamp + 600));

        vm.prank(ENTRY_POINT);
        vm.expectRevert(GatoPagoPaymaster.MissingPaymasterSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_onlyEntryPointCanValidate() public {
        uint48 validUntil = uint48(block.timestamp + 600);
        PackedUserOperation memory op = _baseUserOp();
        bytes memory sig = _sign(_digest(op, 0, validUntil));
        op.paymasterAndData = _paymasterAndData(0, validUntil, sig);

        vm.expectRevert(GatoPagoPaymaster.OnlyEntryPoint.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    // ─── Tamper resistance: every signed field must be bound ────────────────────

    /// A signature over one op must fail for ANY variation of the op's fields
    /// (the sponsor digest binds all of them). Regression net for the digest.
    function test_signatureBindsEveryUserOpField() public {
        uint48 validAfter = 0;
        uint48 validUntil = uint48(block.timestamp + 600);
        PackedUserOperation memory base = _baseUserOp();
        bytes memory sig = _sign(_digest(base, validAfter, validUntil));
        bytes memory pmData = _paymasterAndData(validAfter, validUntil, sig);

        PackedUserOperation memory op;

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.sender = address(0xD00D);
        _assertSigFails(op, validAfter, validUntil, "sender");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.nonce = base.nonce + 1;
        _assertSigFails(op, validAfter, validUntil, "nonce");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.initCode = hex"60006000";
        _assertSigFails(op, validAfter, validUntil, "initCode");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.callData = hex"5678";
        _assertSigFails(op, validAfter, validUntil, "callData");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.accountGasLimits = bytes32(uint256(0x999));
        _assertSigFails(op, validAfter, validUntil, "accountGasLimits");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.preVerificationGas = base.preVerificationGas + 1;
        _assertSigFails(op, validAfter, validUntil, "preVerificationGas");

        op = _baseUserOp();
        op.paymasterAndData = pmData;
        op.gasFees = bytes32(uint256(0x333));
        _assertSigFails(op, validAfter, validUntil, "gasFees");

        // Tampered paymaster gas limits (the signed header hash changes).
        op = _baseUserOp();
        op.paymasterAndData = abi.encodePacked(
            abi.encodePacked(address(paymaster), VER_GAS + 1, POSTOP_GAS), validAfter, validUntil, sig
        );
        _assertSigFails(op, validAfter, validUntil, "paymaster header");

        // Control: the untampered op validates.
        op = _baseUserOp();
        op.paymasterAndData = pmData;
        vm.prank(ENTRY_POINT);
        (, uint256 ok) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(ok, ERC4337Utils.packValidationData(true, validAfter, validUntil), "control op must validate");
    }

    function _assertSigFails(PackedUserOperation memory op, uint48 validAfter, uint48 validUntil, string memory label)
        internal
    {
        vm.prank(ENTRY_POINT);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(
            validationData,
            ERC4337Utils.packValidationData(false, validAfter, validUntil),
            string.concat("tampered ", label, " must fail signature validation")
        );
    }

    // ─── Stake lifecycle (a stake without unlock/withdraw is locked forever) ────

    function test_stakeLifecycleForwardsToEntryPoint() public {
        // Give the EntryPoint address code so the forwarded calls succeed.
        vm.etch(ENTRY_POINT, hex"00");
        vm.deal(address(this), 1 ether);

        vm.expectCall(ENTRY_POINT, 0.5 ether, abi.encodeWithSignature("addStake(uint32)", uint32(86400)));
        paymaster.addStake{value: 0.5 ether}(86400);

        vm.expectCall(ENTRY_POINT, abi.encodeWithSignature("unlockStake()"));
        paymaster.unlockStake();

        vm.expectCall(ENTRY_POINT, abi.encodeWithSignature("withdrawStake(address)", address(this)));
        paymaster.withdrawStake(payable(address(this)));
    }

    function test_stakeLifecycleOnlyOwner() public {
        vm.etch(ENTRY_POINT, hex"00");
        vm.startPrank(address(0xBAD));
        vm.expectRevert();
        paymaster.unlockStake();
        vm.expectRevert();
        paymaster.withdrawStake(payable(address(0xBAD)));
        vm.stopPrank();
    }

    function test_depositReceiveWithdrawAndGetDeposit() public {
        MockPaymasterEntryPoint entryPoint = new MockPaymasterEntryPoint();
        GatoPagoPaymaster localPaymaster = new GatoPagoPaymaster(IEntryPoint(address(entryPoint)), address(this));
        vm.deal(address(this), 3 ether);

        localPaymaster.deposit{value: 1 ether}();
        (bool sent,) = address(localPaymaster).call{value: 1 ether}("");
        assertTrue(sent);
        assertEq(localPaymaster.getDeposit(), 2 ether);

        address payable recipient = payable(address(0xCAFE));
        localPaymaster.withdrawTo(recipient, 0.75 ether);
        assertEq(recipient.balance, 0.75 ether);
        assertEq(localPaymaster.getDeposit(), 1.25 ether);
    }

    function test_postOp_onlyEntryPoint() public {
        vm.expectRevert(GatoPagoPaymaster.OnlyEntryPoint.selector);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);

        vm.prank(ENTRY_POINT);
        paymaster.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
    }
}
