// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {AccountV3Storage as S} from "src/v3/AccountV3Storage.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";

/// @dev Compiler probe ONLY. It deliberately exposes the struct to solc's storageLayout output.
/// Never deploy this probe or the unrestricted harness as an account.
contract AccountV3StorageLayoutProbe {
    S.Layout private _layoutProbe;
}

contract AccountV3StorageHarness {
    function seed() external {
        S.Layout storage state = S.layout();
        state.generation = 3;
        state.initialized = true;
        state.upgradesFrozen = true;
        state.securityVersion = 7;
        state.initialSecurityCommitment = keccak256("synthetic-initial-policy");
        state.userSaltCommitment = keccak256("synthetic-salt");
        state.manifestHash = keccak256("synthetic-manifest");
        state.policy.mode = 1;
        state.policy.spendThreshold = 1;
        state.policy.adminThreshold = 2;
        state.policy.upgradeDelaySeconds = T.MIN_UPGRADE_DELAY;
        // Raw layout fixture, not a valid quorum or an authorization entrypoint.
        state.policy.signers.push(S.StoredSigner(0, 3, address(0x1234), bytes32(0), hex""));
    }

    function setNonces(uint256 spend, uint256 admin) external {
        S.layout().spendNonce = spend;
        S.layout().adminNonce = admin;
    }

    function getNonces() external view returns (uint256, uint256) {
        return (S.layout().spendNonce, S.layout().adminNonce);
    }

    function replaceAndClearPending() external {
        S.Layout storage state = S.layout();
        state.pending.kind = S.ProposalKind.Security;
        state.pending.nextPolicy.signers.push(T.SignerDescriptor(0, address(0), bytes32(0), hex"abcdef", 3));
        state.pending.upgrade.runtimeCodeHash = keccak256("must-clear");
        delete state.pending;
    }

    function currentPolicyHash() external view returns (bytes32) {
        return T.hashPolicy(PS.load(S.layout().policy));
    }

    function pendingEmpty() external view returns (bool) {
        S.PendingProposal storage p = S.layout().pending;
        return p.kind == S.ProposalKind.None && p.nextPolicy.signers.length == 0 && p.upgrade.runtimeCodeHash == 0;
    }
}

contract AccountV3StorageTest is Test {
    AccountV3StorageHarness internal harness;
    bytes32 internal constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    function setUp() public {
        harness = new AccountV3StorageHarness();
        harness.seed();
    }

    function test_namespaceFormulaAndIndependentRoots() public pure {
        bytes32 computed =
            keccak256(abi.encode(uint256(keccak256("gatopago.account.v3")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(S.STORAGE_LOCATION, computed);
        assertEq(uint256(computed) & 0xff, 0);
        assertNotEq(computed, IMPLEMENTATION_SLOT);
        assertNotEq(computed, bytes32(0));
    }

    function test_layoutUsesItsDeclaredNamespaceWithoutTouchingTheProxySlot() public view {
        uint256 expectedHeader = uint256(3) | (uint256(1) << 32) | (uint256(1) << 40) | (uint256(7) << 48);
        assertEq(vm.load(address(harness), S.STORAGE_LOCATION), bytes32(expectedHeader));
        assertEq(
            vm.load(address(harness), bytes32(uint256(S.STORAGE_LOCATION) + 1)), keccak256("synthetic-initial-policy")
        );
        assertEq(vm.load(address(harness), bytes32(0)), bytes32(0));
        assertEq(vm.load(address(harness), IMPLEMENTATION_SLOT), bytes32(0));
    }

    function test_pendingDeletionDoesNotErasePolicyFreezeOrNonces() public {
        harness.setNonces(1, 2);
        bytes32 header = vm.load(address(harness), S.STORAGE_LOCATION);
        bytes32 policyHash = harness.currentPolicyHash();
        harness.replaceAndClearPending();
        assertTrue(harness.pendingEmpty());
        assertEq(vm.load(address(harness), S.STORAGE_LOCATION), header);
        assertEq(harness.currentPolicyHash(), policyHash);
        (uint256 spend, uint256 admin) = harness.getNonces();
        assertEq(spend, 1);
        assertEq(admin, 2);
    }

    function testFuzz_nonceDomainsDoNotAlias(uint256 spend, uint256 admin) public {
        bytes32 policyHash = harness.currentPolicyHash();
        bytes32 header = vm.load(address(harness), S.STORAGE_LOCATION);
        harness.setNonces(spend, admin);
        (uint256 storedSpend, uint256 storedAdmin) = harness.getNonces();
        assertEq(storedSpend, spend);
        assertEq(storedAdmin, admin);
        assertEq(harness.currentPolicyHash(), policyHash);
        assertEq(vm.load(address(harness), S.STORAGE_LOCATION), header);
        assertEq(vm.load(address(harness), IMPLEMENTATION_SLOT), bytes32(0));
    }
}
