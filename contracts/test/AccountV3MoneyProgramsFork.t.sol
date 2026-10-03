// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {EntryPoint} from "@entrypoint/core/EntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Execution} from "src/v3/AccountV3Execution.sol";
import {V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {V3MoneyProgramFixture} from "test/AccountV3MoneyPrograms.t.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";

// Minimal selectors from Aave's IPoolAddressesProvider/IACLManager/
// IPoolConfigurator. These permissions are exercised only on the local fork.
interface MoneyForkAddressesProvider {
    function getACLManager() external view returns (address);
    function getACLAdmin() external view returns (address);
    function getPoolConfigurator() external view returns (address);
}
interface MoneyForkACLManager {
    function hasRole(bytes32 role, address actor) external view returns (bool);
    function addEmergencyAdmin(address actor) external;
    function isEmergencyAdmin(address actor) external view returns (bool);
}
interface MoneyForkConfigurator {
    function setReservePause(address asset, bool paused) external;
}
interface MoneyForkPoolConfiguration {
    function getConfiguration(address asset) external view returns (uint256);
}

/// @dev Fixed Arbitrum Sepolia block and deployed production Account V3 stack.
/// Public scalar 1 and cheatcode funding are local only; no public user ceremony,
/// live transaction, relayer admission or mainnet readiness is demonstrated.
contract AccountV3MoneyProgramsForkTest is V3MoneyProgramFixture {
    address private token;
    address private pool;
    address private aToken;
    address private provider;
    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0, "pinned money fork requires ARBITRUM_SEPOLIA_RPC_URL");
        string memory json = vm.readFile("test/fixtures/money-arbitrum-sepolia-pins.json");
        uint256 number = vm.parseJsonUint(json, ".block_number");
        vm.createSelectFork(rpc, number);
        assertEq(block.chainid, 421614);
        // Pin the raw execution header, independent of Nitro's L1 block.number.
        assertEq(keccak256(vm.getRawBlockHeader(number)), vm.parseJsonBytes32(json, ".block_hash"));
        ep = EntryPoint(payable(vm.parseJsonAddress(json, ".account.deployment.entry_point")));
        assertEq(address(ep).codehash, vm.parseJsonBytes32(json, ".account.entry_point_code_hash"));
        factory = AccountFactoryV3(_code(json, ".account.deployment.components.factory"));
        implementation = V3ExecutionAccount(payable(_code(json, ".account.deployment.components.implementation")));
        _code(json, ".account.deployment.components.security_module"); _code(json, ".account.deployment.components.upgrade_module");
        address verifier = _code(json, ".account.webauthn_verifier");
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        for (uint256 i; i < 4; ++i) {
            string memory key = string.concat(".market.contracts[", vm.toString(i), "]");
            bytes32 name = keccak256(bytes(vm.parseJsonString(json, string.concat(key, ".name"))));
            address target = vm.parseJsonAddress(json, string.concat(key, ".address"));
            assertEq(target.codehash, vm.parseJsonBytes32(json, string.concat(key, ".code_hash")));
            // Pool and aToken are the two explicitly admitted EIP-1967 proxies.
            if (name == keccak256("pool") || name == keccak256("a_token")) {
                address impl = vm.parseJsonAddress(json, string.concat(key, ".implementation"));
                assertEq(address(uint160(uint256(vm.load(target, slot)))), impl);
                assertEq(impl.codehash, vm.parseJsonBytes32(json, string.concat(key, ".implementation_code_hash")));
            } else assertEq(vm.load(target, slot), bytes32(0));
            if (name == keccak256("token")) token = target;
        }
        pool = vm.parseJsonAddress(json, ".market.pool"); aToken = vm.parseJsonAddress(json, ".market.a_token");
        provider = vm.parseJsonAddress(json, ".market.provider");
        bundler = makeAddr("money-local-fork-bundler"); beneficiary = payable(makeAddr("money-local-fork-beneficiary"));
        recipient = makeAddr("money-local-fork-recipient");
        policy.mode = P.ACTIVE; policy.spendThreshold = 1; policy.adminThreshold = 1; policy.upgradeDelaySeconds = 72 hours;
        (uint256 x, uint256 y) = vm.publicKeyP256(1);
        policy.signers.push(T.SignerDescriptor(P.WEBAUTHN, verifier, verifier.codehash,
            abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), x, y), P.SPEND | P.ADMIN));
        initial = _initial(policy, keccak256("money-pinned-fork-public-vector"));
        account = V3ExecutionAccount(payable(_predicted(initial)));
        vm.deal(address(account), 10 ether);
        // Conservative software fallback; does not mock valid signature results.
        vm.mockCall(address(0x100), bytes(""), bytes(""));
        _submit(_gas(_operation(initial, policy, new T.Call[](0)), 4_000_000, 100_000));
        deal(token, address(account), 100e6);
    }
    function _code(string memory json, string memory key) private view returns (address target) {
        target = vm.parseJsonAddress(json, string.concat(key, ".address"));
        assertEq(target.codehash, vm.parseJsonBytes32(json, string.concat(key, ".runtime_code_hash")));
    }
    function _pauseReserveLocally() private {
        MoneyForkAddressesProvider addresses = MoneyForkAddressesProvider(provider);
        MoneyForkACLManager acl = MoneyForkACLManager(addresses.getACLManager());
        address admin = addresses.getACLAdmin();
        assertTrue(acl.hasRole(bytes32(0), admin));
        // Impersonation changes this isolated fork only, never public access.
        vm.prank(admin); acl.addEmergencyAdmin(address(this));
        assertTrue(acl.isEmergencyAdmin(address(this)));
        MoneyForkConfigurator(addresses.getPoolConfigurator()).setReservePause(token, true);
        assertEq((MoneyForkPoolConfiguration(pool).getConfiguration(token) >> 60) & 1, 1);
    }
    function _assertPoolRevert(T.Call memory call, string memory code) private {
        assertEq(call.target, pool);
        vm.prank(address(account));
        (bool success, bytes memory reason) = pool.call(call.data);
        assertFalse(success);
        assertEq(reason, abi.encodeWithSignature("Error(string)", code));
    }
    function _runRejectedAtPool(T.Call[] memory calls, uint256 index) private {
        uint256 execution = calls.length == 4 ? 400_000 : calls.length == 1 ? 200_000 : 250_000;
        PackedUserOperation memory op = _gas(_operation(initial, policy, calls), 496_000, execution);
        bytes32 hash = ep.getUserOpHash(op);
        bytes32 reasonEvent = keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)");
        uint256 outcomes;
        uint256 reasons;
        vm.recordLogs(); _submit(op); Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ep) || logs[i].topics.length < 2 || logs[i].topics[1] != hash) continue;
            if (logs[i].topics[0] == OP_EVENT) {
                (uint256 nonce, bool success, uint256 cost, uint256 gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                assertEq(nonce, op.nonce); assertFalse(success); assertGt(cost, 0); assertGt(gasUsed, 0); ++outcomes;
            }
            if (logs[i].topics[0] == reasonEvent) {
                (uint256 nonce, bytes memory reason) = abi.decode(logs[i].data, (uint256, bytes));
                assertEq(nonce, op.nonce);
                assertEq(reason, abi.encodeWithSelector(AccountV3Execution.AccountV3Execution__CallFailed.selector, index, pool));
                ++reasons;
            }
        }
        assertEq(outcomes, 1); assertEq(reasons, 1); assertEq(account.getNonce(), op.nonce + 1);
    }
    function test_pinnedMarketThreeRecipesThroughDeployedConsumerAccount() public {
        vm.cool(address(account)); vm.cool(pool); vm.cool(token); vm.cool(aToken);
        (, uint256 gasUsed) = _run(_supply(token, pool, 40e6), true);
        emit log_named_uint("pinned fork supply software P256 UserOperation gas", gasUsed);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6); assertEq(IERC20(token).allowance(address(account), pool), 0);
        vm.cool(address(account)); vm.cool(pool); vm.cool(token); vm.cool(aToken);
        (, gasUsed) = _run(_withdraw(token, pool, 10e6, false), true);
        emit log_named_uint("pinned fork withdraw software P256 UserOperation gas", gasUsed);
        assertEq(IERC20(token).balanceOf(address(account)), 70e6);
        vm.cool(address(account)); vm.cool(pool); vm.cool(token); vm.cool(aToken);
        (, gasUsed) = _run(_withdraw(token, pool, 20e6, true), true);
        emit log_named_uint("pinned fork withdraw-and-pay software P256 UserOperation gas", gasUsed);
        assertEq(IERC20(token).balanceOf(address(account)), 70e6); assertEq(IERC20(token).balanceOf(recipient), 20e6);
        assertApproxEqAbs(IERC20(aToken).balanceOf(address(account)), 10e6, 1);
        assertEq(account.getNonce(), 4);
    }
    function test_pinnedUsdcRevertingPaymentRollsBackWithdrawAndChargesGas() public {
        _run(_supply(token, pool, 40e6), true);
        uint256 position = IERC20(aToken).balanceOf(address(account)); recipient = address(0);
        _run(_withdraw(token, pool, 20e6, true), false);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6); assertEq(IERC20(aToken).balanceOf(address(account)), position);
        assertEq(IERC20(token).balanceOf(recipient), 0); assertEq(account.getNonce(), 3);
    }
    function test_pinnedSupplyReplacesExistingAllowanceAndClearsItAfterDeposit() public {
        T.Call[] memory calls = new T.Call[](1);
        calls[0] = T.Call(token, 0, abi.encodeCall(IERC20.approve, (pool, 7e6)));
        _run(calls, true);
        assertEq(IERC20(token).allowance(address(account), pool), 7e6);
        _run(_supply(token, pool, 40e6), true);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6);
        assertApproxEqAbs(IERC20(aToken).balanceOf(address(account)), 40e6, 1);
        assertEq(IERC20(token).allowance(address(account), pool), 0);
    }
    function test_pinnedOneAtomicUnitPaymentAfterInterestPreservesAvailableBalance() public {
        _run(_supply(token, pool, 40e6), true);
        // Time advances only in this local fork; no public accrued-interest claim.
        vm.warp(block.timestamp + 1 days);
        uint256 beforePosition = IERC20(aToken).balanceOf(address(account));
        assertGt(beforePosition, 40e6);
        _run(_withdraw(token, pool, 1, true), true);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6);
        assertEq(IERC20(token).balanceOf(recipient), 1);
        assertApproxEqAbs(IERC20(aToken).balanceOf(address(account)), beforePosition - 1, 1);
        assertGt(IERC20(aToken).balanceOf(address(account)), 40e6);
    }
    function test_pinnedPausedSupplyRollsBackApprovalsAndBalances() public {
        _pauseReserveLocally();
        T.Call[] memory calls = _supply(token, pool, 40e6);
        _assertPoolRevert(calls[2], "29");
        _runRejectedAtPool(calls, 2);
        assertEq(IERC20(token).balanceOf(address(account)), 100e6);
        assertEq(IERC20(aToken).balanceOf(address(account)), 0);
        assertEq(IERC20(token).allowance(address(account), pool), 0);
    }
    function test_pinnedPausedPaymentPreservesPositionAndRecipientBalance() public {
        _run(_supply(token, pool, 40e6), true);
        uint256 position = IERC20(aToken).balanceOf(address(account));
        _pauseReserveLocally();
        T.Call[] memory calls = _withdraw(token, pool, 20e6, true);
        _assertPoolRevert(calls[0], "29");
        _runRejectedAtPool(calls, 0);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6);
        assertEq(IERC20(aToken).balanceOf(address(account)), position);
        assertEq(IERC20(token).balanceOf(recipient), 0);
    }
    function test_pinnedInsufficientPositionCannotPayFromAvailableFunds() public {
        T.Call[] memory calls = _withdraw(token, pool, 20e6, true);
        _assertPoolRevert(calls[0], "32");
        _runRejectedAtPool(calls, 0);
        assertEq(IERC20(token).balanceOf(address(account)), 100e6);
        assertEq(IERC20(aToken).balanceOf(address(account)), 0);
        assertEq(IERC20(token).balanceOf(recipient), 0);
    }
    function test_pinnedInsufficientLiquidityRollsBackBurnAndPayment() public {
        _run(_supply(token, pool, 40e6), true);
        uint256 position = IERC20(aToken).balanceOf(address(account));
        // Synthetic liquidity fault only in this local fork; contract code stays pinned.
        deal(token, aToken, 1);
        assertEq(IERC20(token).balanceOf(aToken), 1);
        _runRejectedAtPool(_withdraw(token, pool, 20e6, true), 0);
        assertEq(IERC20(token).balanceOf(address(account)), 60e6);
        assertEq(IERC20(aToken).balanceOf(address(account)), position);
        assertEq(IERC20(token).balanceOf(aToken), 1);
        assertEq(IERC20(token).balanceOf(recipient), 0);
    }
    function test_pinnedUsdcInsufficientTransferRevertsInsteadOfReturningFalse() public {
        // This expected-revert call has no successful ERC20 return to inspect.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vm.prank(address(account)); vm.expectRevert(); IERC20(token).transfer(recipient, 100e6 + 1);
        assertEq(IERC20(token).balanceOf(address(account)), 100e6); assertEq(IERC20(token).balanceOf(recipient), 0);
    }
}
