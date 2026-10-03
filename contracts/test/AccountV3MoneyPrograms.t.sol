// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {V3Deployment} from "script/DeployV3.s.sol";

contract MoneyTokenFixture is ERC20 {
    address public falseRecipient;
    address public revertingRecipient;
    bool public rejectFinalClear;
    constructor() ERC20("Money USDC fixture", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function faults(address returnsFalse, address reverts, bool rejectClear) external {
        falseRecipient = returnsFalse; revertingRecipient = reverts; rejectFinalClear = rejectClear;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        require(to != revertingRecipient, "fixture transfer reverts");
        if (to == falseRecipient) return false;
        return super.transfer(to, amount);
    }
    function approve(address spender, uint256 amount) public override returns (bool) {
        require(!rejectFinalClear || amount != 0 || balanceOf(msg.sender) == 100e6, "fixture final clear reverts");
        return super.approve(spender, amount);
    }
}
contract MoneyATokenFixture is ERC20 {
    constructor() ERC20("Interest position fixture", "aUSDC") {}
    function mint(address owner, uint256 amount) external { _mint(owner, amount); }
    function burn(address owner, uint256 amount) external { _burn(owner, amount); }
}
contract MoneyPoolFixture {
    IERC20 public immutable token;
    MoneyATokenFixture public immutable aToken;
    bool public paused;
    event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode);
    event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount);
    constructor(IERC20 asset, MoneyATokenFixture position) { token = asset; aToken = position; }
    function setPaused(bool value) external { paused = value; }
    function supply(address asset, uint256 amount, address owner, uint16 referral) external {
        require(!paused && asset == address(token) && amount > 0 && referral == 0, "fixture unavailable");
        require(token.transferFrom(msg.sender, address(aToken), amount), "fixture transferFrom false");
        aToken.mint(owner, amount);
        emit Supply(asset, msg.sender, owner, amount, referral);
    }
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(!paused && asset == address(token) && amount > 0 && amount != type(uint256).max, "fixture unavailable");
        aToken.burn(msg.sender, amount);
        // Test-only aToken storage owns the underlying, as in the real Pool recipe.
        MoneyATokenAssetSender(address(aToken)).send(token, to, amount);
        emit Withdraw(asset, msg.sender, to, amount);
        return amount;
    }
}
contract MoneyATokenAssetSender is MoneyATokenFixture {
    function send(IERC20 token, address recipient, uint256 amount) external { require(token.transfer(recipient, amount), "fixture transfer false"); }
}

abstract contract V3MoneyProgramFixture is V3ExecutionFixture {
    bytes32 internal constant OP_EVENT = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    function _gas(PackedUserOperation memory op, uint256 verification, uint256 execution) internal view returns (PackedUserOperation memory) {
        op.accountGasLimits = bytes32((verification << 128) | execution);
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(uint256(100_000_000));
        (T.ExecutionPlan memory plan,) = abi.decode(op.signature, (T.ExecutionPlan, S.Signature[]));
        plan.userOpHash = ep.getUserOpHash(op);
        op.signature = abi.encode(plan, _votes(policy, T.digest(block.chainid, op.sender, T.hashExecution(plan)), P.SPEND));
        return op;
    }
    function _supply(address asset, address market, uint256 amount) internal view returns (T.Call[] memory calls) {
        calls = new T.Call[](4);
        calls[0] = T.Call(asset, 0, abi.encodeCall(IERC20.approve, (market, 0)));
        calls[1] = T.Call(asset, 0, abi.encodeCall(IERC20.approve, (market, amount)));
        calls[2] = T.Call(market, 0, abi.encodeWithSignature("supply(address,uint256,address,uint16)", asset, amount, address(account), uint16(0)));
        calls[3] = T.Call(asset, 0, abi.encodeCall(IERC20.approve, (market, 0)));
    }
    function _withdraw(address asset, address market, uint256 amount, bool pay) internal view returns (T.Call[] memory calls) {
        calls = new T.Call[](pay ? 2 : 1);
        calls[0] = T.Call(market, 0, abi.encodeWithSignature("withdraw(address,uint256,address)", asset, amount, address(account)));
        if (pay) calls[1] = T.Call(asset, 0, abi.encodeCall(IERC20.transfer, (recipient, amount)));
    }
    function _run(T.Call[] memory calls, bool expectedSuccess) internal returns (uint256 actualGasCost, uint256 actualGasUsed) {
        uint256 execution = calls.length == 4 ? 400_000 : calls.length == 1 ? 200_000 : 250_000;
        PackedUserOperation memory op = _gas(_operation(initial, policy, calls), 496_000, execution);
        bytes32 hash = ep.getUserOpHash(op);
        vm.recordLogs(); _submit(op); Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(ep) && logs[i].topics[0] == OP_EVENT && logs[i].topics[1] == hash) {
            (uint256 nonce, bool success, uint256 cost, uint256 gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            assertEq(nonce, op.nonce); assertEq(success, expectedSuccess); actualGasCost = cost; actualGasUsed = gasUsed; ++matches;
        }
        assertEq(matches, 1); assertGt(actualGasCost, 0); assertGt(actualGasUsed, 0);
    }

}

/// @dev Production Account V3/factory/libraries, real EntryPoint and software
/// P256. Only the local financial market and public scalar 1 are synthetic.
contract AccountV3MoneyProgramsTest is V3MoneyProgramFixture {
    MoneyTokenFixture internal token;
    MoneyATokenAssetSender internal aToken;
    MoneyPoolFixture internal pool;

    function setUp() public {
        _setupExecution();
        vm.chainId(421614);
        V3Deployment.Stack memory stack = V3Deployment.deploy(address(ep));
        implementation = V3ExecutionAccount(payable(address(stack.implementation)));
        factory = stack.factory;
        (uint256 x, uint256 y) = vm.publicKeyP256(1);
        policy.mode = P.ACTIVE;
        policy.spendThreshold = 1; policy.adminThreshold = 1;
        delete policy.signers;
        policy.signers.push(T.SignerDescriptor(P.WEBAUTHN, address(stack.verifier), address(stack.verifier).codehash,
            abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), x, y), P.SPEND | P.ADMIN));
        initial = _initial(policy, keccak256("money-programs-software-p256"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        vm.deal(address(account), 10 ether);
        vm.mockCall(address(0x100), bytes(""), bytes(""));
        // Creation's separate measurement ceiling does not admit a runtime cap.
        _submit(_gas(_operation(initial, policy, new T.Call[](0)), 4_000_000, 100_000));
        token = new MoneyTokenFixture(); aToken = new MoneyATokenAssetSender();
        pool = new MoneyPoolFixture(IERC20(address(token)), aToken);
        token.mint(address(account), 100e6);
    }

    function test_threeRecipesUseSpendAndLeaveExactPrincipalAndZeroAllowance() public {
        (, uint256 gasUsed) = _run(_supply(address(token), address(pool), 40e6), true);
        emit log_named_uint("supply software P256 UserOperation gas (synthetic market)", gasUsed);
        assertEq(token.balanceOf(address(account)), 60e6); assertEq(aToken.balanceOf(address(account)), 40e6);
        assertEq(token.allowance(address(account), address(pool)), 0);
        (, gasUsed) = _run(_withdraw(address(token), address(pool), 10e6, false), true);
        emit log_named_uint("withdraw software P256 UserOperation gas (synthetic market)", gasUsed);
        assertEq(token.balanceOf(address(account)), 70e6); assertEq(aToken.balanceOf(address(account)), 30e6);
        (, gasUsed) = _run(_withdraw(address(token), address(pool), 20e6, true), true);
        emit log_named_uint("withdraw-and-pay software P256 UserOperation gas (synthetic market)", gasUsed);
        assertEq(token.balanceOf(address(account)), 70e6); assertEq(token.balanceOf(recipient), 20e6);
        assertEq(aToken.balanceOf(address(account)), 10e6); assertEq(account.getNonce(), 4);
    }
    function test_supplyReplacesExistingAllowanceAndClearsItAfterDeposit() public {
        T.Call[] memory calls = new T.Call[](1);
        calls[0] = T.Call(address(token), 0, abi.encodeCall(IERC20.approve, (address(pool), 7e6)));
        _run(calls, true);
        assertEq(token.allowance(address(account), address(pool)), 7e6);
        _run(_supply(address(token), address(pool), 40e6), true);
        assertEq(token.balanceOf(address(account)), 60e6); assertEq(aToken.balanceOf(address(account)), 40e6);
        assertEq(token.allowance(address(account), address(pool)), 0);
    }
    function test_failedFinalAllowanceClearRollsBackEntireSupplyButConsumesUserOpGas() public {
        token.faults(address(0), address(0), true);
        (uint256 cost,) = _run(_supply(address(token), address(pool), 40e6), false);
        assertGt(cost, 0); assertEq(token.balanceOf(address(account)), 100e6); assertEq(aToken.balanceOf(address(account)), 0);
        assertEq(token.allowance(address(account), address(pool)), 0); assertEq(account.getNonce(), 2);
    }
    function test_failedPaymentRollsBackWithdrawalAndPositionButConsumesNonceAndGas() public {
        _run(_supply(address(token), address(pool), 40e6), true);
        token.faults(address(0), recipient, false);
        _run(_withdraw(address(token), address(pool), 20e6, true), false);
        assertEq(token.balanceOf(address(account)), 60e6); assertEq(token.balanceOf(recipient), 0);
        assertEq(aToken.balanceOf(address(account)), 40e6); assertEq(account.getNonce(), 3);
    }
    function test_falseReturningTokenDemonstratesWhyCallsExecutedAloneCannotProvePayment() public {
        _run(_supply(address(token), address(pool), 40e6), true);
        token.faults(recipient, address(0), false);
        _run(_withdraw(address(token), address(pool), 20e6, true), true);
        assertEq(token.balanceOf(recipient), 0); assertEq(token.balanceOf(address(account)), 80e6);
        assertEq(aToken.balanceOf(address(account)), 20e6);
        // Generic Account V3 checks EVM CALL status, not an arbitrary return value.
        // Production receipt verification must reject this missing Transfer effect.
    }
    function test_interestAccrualDoesNotChangeTheSignedWithdrawPrincipal() public {
        _run(_supply(address(token), address(pool), 40e6), true);
        token.mint(address(aToken), 19); aToken.mint(address(account), 19);
        _run(_withdraw(address(token), address(pool), 20e6, true), true);
        assertEq(token.balanceOf(recipient), 20e6); assertEq(aToken.balanceOf(address(account)), 20e6 + 19);
    }
    function test_pausedAndInsufficientPositionLeaveNoPartialEffects() public {
        pool.setPaused(true); _run(_supply(address(token), address(pool), 40e6), false);
        assertEq(token.balanceOf(address(account)), 100e6); assertEq(token.allowance(address(account), address(pool)), 0);
        pool.setPaused(false); _run(_withdraw(address(token), address(pool), 1, true), false);
        assertEq(token.balanceOf(recipient), 0); assertEq(aToken.balanceOf(address(account)), 0);
    }
}
