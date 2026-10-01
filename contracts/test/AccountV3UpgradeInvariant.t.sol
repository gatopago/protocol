// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {V3ExecutionFixture, V3ExecutionAccount} from "test/helpers/V3ExecutionFixture.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountFactoryV3 as Factory} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Upgrade as Upgrade} from "src/v3/AccountV3Upgrade.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Real factory/EntryPoint creation, real signed upgrades on the composed proxy, no state seeds.
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract AccountV3UpgradeInvariantTest is V3ExecutionFixture {
    V3ExecutionAccount private revision;
    uint256 private committed;
    uint256 private proposed;
    uint256 private cancelled;
    uint256 private transferred;
    uint256 private initialBalance;
    uint256 private readyAt;
    uint256 private expiresAt;
    bool private frozen;

    function setUp() external {
        _setupExecution();
        _create();
        revision = new V3ExecutionAccount(address(ep));
        initialBalance = address(account).balance;
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = this.queue.selector;
        selectors[1] = this.advance.selector;
        selectors[2] = this.commitPending.selector;
        selectors[3] = this.cancelPending.selector;
        selectors[4] = this.expirePending.selector;
        selectors[5] = this.freezePending.selector;
        selectors[6] = this.spend.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector(address(this), selectors));
    }

    function invariant_inspectionTracksActualRevisionWithoutChangingIdentity() public view {
        address target = _implementation();
        assertTrue(target == address(implementation) || target == address(revision));
        Factory.ImplementationExpectation memory expected = Factory.ImplementationExpectation(
            target,
            target.codehash,
            D.LAYOUT_HASH,
            address(Security),
            address(Security).codehash,
            address(Upgrade),
            address(Upgrade).codehash
        );
        Factory.AccountInspection memory seen =
            factory.inspectAccount(initial.initialSecurityCommitment, initial.userSaltCommitment, expected);
        assertEq(seen.account, address(account));
        assertEq(seen.accountId, initial.accountId);
        assertEq(seen.implementation, target);
        assertEq(seen.securityVersion, 1 + committed);
        assertEq(seen.storageLayoutHash, D.LAYOUT_HASH);
    }

    function queue() public {
        (, uint8 kind) = account.proposal();
        if (frozen || kind != uint8(D.ProposalKind.None)) return;
        (bytes32 manifest, uint256 nonce,,) = account.securityState();
        address target = _implementation() == address(implementation) ? address(revision) : address(implementation);
        T.UpgradeManifest memory message = T.UpgradeManifest(
            initial.accountId,
            3,
            account.securityVersion(),
            manifest,
            target,
            target.codehash,
            D.LAYOUT_HASH,
            keccak256(abi.encode(_chains())),
            keccak256(""),
            nonce,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 10 days)
        );
        account.proposeUpgrade(
            message,
            _chains(),
            _votes(policy, T.digest(block.chainid, address(account), T.hashUpgrade(message)), P.ADMIN)
        );
        ++proposed;
        readyAt = block.timestamp + 72 hours;
        expiresAt = block.timestamp + 10 days;
    }

    function advance(uint32 elapsed) public {
        vm.warp(block.timestamp + bound(elapsed, 1, 11 days));
    }

    function commitPending() public {
        (, uint8 kind) = account.proposal();
        // Synthetic clock selects a test validity boundary, not randomness or production finality.
        // forge-lint: disable-next-line(block-timestamp)
        if (kind != uint8(D.ProposalKind.Upgrade) || block.timestamp < readyAt || block.timestamp >= expiresAt) return;
        T.CommitProposal memory message = _executionCommit();
        account.commitUpgrade(
            message, "", _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(message)), P.ADMIN)
        );
        ++committed;
    }

    function cancelPending() public {
        (bytes32 proposal, uint8 kind) = account.proposal();
        if (kind == uint8(D.ProposalKind.None)) return;
        T.CancelProposal memory message = T.CancelProposal(
            initial.accountId,
            3,
            account.securityVersion(),
            proposal,
            account.securitySnapshot()[7],
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes)
        );
        account.cancel(
            message, _votes(policy, T.digest(block.chainid, address(account), T.hashCancel(message)), P.ADMIN)
        );
        ++cancelled;
    }

    function expirePending() public {
        (bytes32 proposal, uint8 kind) = account.proposal();
        // Synthetic clock selects a test validity boundary, not randomness or production finality.
        // forge-lint: disable-next-line(block-timestamp)
        if (kind == uint8(D.ProposalKind.None) || block.timestamp < expiresAt) return;
        account.expire(proposal);
    }

    function freezePending() public {
        if (frozen) return;
        T.FreezeUpgrades memory message = _executionFreeze();
        account.freeze(
            message,
            _chains(),
            _votes(policy, T.digest(block.chainid, address(account), T.hashFreeze(message)), P.ADMIN)
        );
        frozen = true;
    }

    function spend() public {
        if (address(account).balance == 0) return;
        T.Call[] memory calls = _calls(recipient, 1, "");
        (T.ExecutionPlan memory plan, S.Signature[] memory votes) = _direct(calls);
        account.executeSigned(calls, plan, votes);
        ++transferred;
    }

    function test_handlerCanUpgradeRepeatedlyCancelExpireFreezeAndStillExit() external {
        queue();
        advance(72 hours);
        commitPending();
        spend();
        queue();
        advance(72 hours);
        commitPending();
        queue();
        cancelPending();
        queue();
        advance(11 days);
        expirePending();
        queue();
        freezePending();
        spend();
        assertEq(committed, 2);
        assertEq(proposed, 5);
        assertEq(cancelled, 1);
        assertEq(transferred, 2);
        invariant_upgradeNeverChangesIdentityPolicyOrThawsFreeze();
        invariant_upgradePreservesAssetsAndPurposeNonces();
    }

    function invariant_upgradeNeverChangesIdentityPolicyOrThawsFreeze() public view {
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) = account.creationIdentity();
        assertEq(generation, 3);
        assertEq(id, initial.accountId);
        assertEq(commitment, initial.initialSecurityCommitment);
        assertEq(salt, initial.userSaltCommitment);
        assertEq(account.securityVersion(), committed + 1);
        assertEq(T.hashPolicy(account.securityPolicy()), T.hashPolicy(policy));
        (,,, bool onchainFrozen) = account.securityState();
        assertEq(onchainFrozen, frozen);
        assertFalse(account.executing());
        assertTrue(_implementation() == address(implementation) || _implementation() == address(revision));
    }

    function invariant_upgradePreservesAssetsAndPurposeNonces() public view {
        assertEq(account.directNonce(), transferred);
        assertEq(address(account).balance + recipient.balance, initialBalance);
        assertEq(recipient.balance, transferred);
        (, uint256 admin,,) = account.securityState();
        assertEq(admin, proposed + committed + cancelled + (frozen ? 1 : 0));
    }

    function _implementation() private view returns (address) {
        return address(uint160(uint256(vm.load(address(account), ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
