// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {EntryPoint} from "@entrypoint/core/EntryPoint.sol";
import {PackedUserOperation} from "@entrypoint/interfaces/PackedUserOperation.sol";
import {V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {V3MoneyProgramFixture} from "test/AccountV3MoneyPrograms.t.sol";
import {AccountV3Execution} from "src/v3/AccountV3Execution.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";

/// @dev Cross-language vectors are unsigned and fixed synthetic inputs. Solidity
/// independently reconstructs the recipe ABI, EntryPoint hash and EIP712 digest.
contract AccountV3MoneyProgramsGoldenTest is V3MoneyProgramFixture {
    function test_compiledSdkVectorsMatchSolidityAndEntryPoint09() public {
        vm.chainId(421614);
        EntryPoint implementationEp = new EntryPoint();
        address vectorEp = 0x3333333333333333333333333333333333333333;
        vm.etch(vectorEp, address(implementationEp).code);
        EntryPoint goldenEp = EntryPoint(payable(vectorEp));
        string memory json = vm.readFile("test/fixtures/money-programs-golden.json");
        for (uint256 i; i < 3; ++i) {
            string memory prefix = string.concat(".vectors[", vm.toString(i), "]");
            account = V3ExecutionAccount(payable(vm.parseJsonAddress(json, string.concat(prefix, ".account"))));
            recipient = 0x2222222222222222222222222222222222222222;
            address asset = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
            address market = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
            T.Call[] memory calls = i == 0 ? _supply(asset, market, 20e6) : _withdraw(asset, market, 20e6, i == 2);
            assertEq(abi.encode(calls), vm.parseJsonBytes(json, string.concat(prefix, ".calls_abi")));
            bytes memory data = abi.encodeCall(AccountV3Execution.execute, (calls, uint64(2)));
            assertEq(data, vm.parseJsonBytes(json, string.concat(prefix, ".calldata")));
            PackedUserOperation memory op;
            op.sender = address(account); op.nonce = 7; op.callData = data;
            op.accountGasLimits = bytes32((uint256(496_000) << 128) | 400_000);
            op.preVerificationGas = 100_000; op.gasFees = bytes32(uint256(100_000_000));
            bytes32 userOpHash = goldenEp.getUserOpHash(op);
            assertEq(userOpHash, vm.parseJsonBytes32(json, string.concat(prefix, ".userop_hash")));
            T.ExecutionPlan memory plan = abi.decode(vm.parseJsonBytes(json, string.concat(prefix, ".plan_abi")), (T.ExecutionPlan));
            assertEq(plan.callsHash, keccak256(abi.encode(calls))); assertEq(plan.userOpHash, userOpHash);
            assertEq(plan.assetLimitsHash, vm.parseJsonBytes32(json, string.concat(prefix, ".asset_limits_hash")));
            assertEq(plan.feePolicyHash, vm.parseJsonBytes32(json, string.concat(prefix, ".fee_policy_hash")));
            assertEq(plan.previewHash, vm.parseJsonBytes32(json, string.concat(prefix, ".preview_hash")));
            assertEq(T.digest(421614, address(account), T.hashExecution(plan)), vm.parseJsonBytes32(json, string.concat(prefix, ".consent_digest")));
        }
    }
}
