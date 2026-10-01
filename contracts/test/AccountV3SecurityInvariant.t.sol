// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {V3SecurityFixture, V3SecurityHarness} from "test/helpers/V3SecurityFixture.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";

contract V3SecurityInvariantToken is ERC20 {
    constructor(address recipient) ERC20("Security invariant fixture", "TEST") {
        _mint(recipient, 100 ether);
    }
}

/// @dev Calls only the real stateful library via a harness without mutation/seed backdoors.
/// Signatures use synthetic ECDSA keys; no forged witnesses, vm.store or mocked validators.
contract V3SecurityHandler is V3SecurityFixture {
    V3SecurityHarness public immutable account;
    uint256 public adminAccepted;
    uint256 public installed;
    uint256 public cancelled;
    uint256 public expired;
    uint256 public rejected;
    bool public frozen;
    bytes32 public expectedPolicy;
    bytes32 public expectedManifest;

    constructor(V3SecurityHarness initializedAccount) {
        _setupKeys();
        T.SecurityPolicy memory policy = _policy(alice, bob);
        account = address(initializedAccount) == address(0)
            ? new V3SecurityHarness(policy, keccak256(abi.encode(_chains())))
            : initializedAccount;
        expectedPolicy = T.hashPolicy(policy);
        expectedManifest = account.snapshot().manifest;
        assertState();
    }

    function prepare(uint256 seed, bool) external {
        V3SecurityHarness.Snapshot memory before_ = account.snapshot();
        if (before_.pending.kind != D.ProposalKind.None) return;
        T.SecurityPolicy memory next;
        if (seed % 3 == 0) next = _policy(alice, carol);
        else if (seed % 3 == 1) next = _policy(bob, dave);
        else next = _policy(alice, bob);
        if (T.hashPolicy(next) == expectedPolicy) next.spendThreshold = before_.policy.spendThreshold == 1 ? 2 : 1;
        E.ChangeKind kind = E.ChangeKind.Security;
        T.SecurityChange memory message = _change(account, next, kind);
        bytes32 expectedHash = _context(account, message, kind);
        bytes32 proposal = _prepare(account, next, kind);
        ++adminAccepted;
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        assertEq(proposal, expectedHash);
        assertEq(state.pending.proposalHash, expectedHash);
        assertEq(state.pending.securityVersion, before_.version);
        assertEq(state.pending.previousManifestHash, before_.manifest);
        assertEq(state.pending.readyAt, block.timestamp);
        assertEq(state.pending.validUntil, message.proposalValidUntil);
        assertEq(T.hashPolicy(state.pending.nextPolicy), T.hashPolicy(next));
        assertState();
    }

    function commitOrActivate() external {
        V3SecurityHarness.Snapshot memory before_ = account.snapshot();
        D.PendingProposal memory pending = before_.pending;
        // Test scheduler only selects ready proposals; production enforces the same half-open window.
        // forge-lint: disable-start(block-timestamp)
        if (
            pending.kind == D.ProposalKind.None || block.timestamp < pending.readyAt
                || block.timestamp >= pending.validUntil
        ) return;
        // forge-lint: disable-end(block-timestamp)
        expectedPolicy = T.hashPolicy(pending.nextPolicy);
        expectedManifest = T.hashManifest(
            T.SecurityManifest(
                before_.id, 3, before_.version + 1, before_.manifest, expectedPolicy, pending.chainScopeHash
            )
        );
        _commit(account);
        ++adminAccepted;
        ++installed;
        assertEq(uint8(account.snapshot().pending.kind), uint8(D.ProposalKind.None));
        assertState();
    }

    function cancel(uint256) external {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        if (state.pending.kind == D.ProposalKind.None) return;
        _cancel(account);
        ++adminAccepted;
        ++cancelled;
        assertState();
    }

    function expire() external {
        D.PendingProposal memory pending = account.snapshot().pending;
        // Fixture clock determines whether to attempt permissionless expiry, never randomness.
        // forge-lint: disable-next-line(block-timestamp)
        if (pending.kind == D.ProposalKind.None || block.timestamp < pending.validUntil) return;
        account.expire(pending.proposalHash);
        ++expired;
        assertState();
    }

    function advance(uint48 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 12 days));
    }

    function freeze() external {
        if (frozen) return;
        D.PendingProposal memory pending = account.snapshot().pending;
        _freeze(account);
        frozen = true;
        ++adminAccepted;
        if (pending.kind == D.ProposalKind.Security) {
            assertEq(account.snapshot().pending.proposalHash, pending.proposalHash);
            assertEq(account.snapshot().pending.readyAt, pending.readyAt);
        }
        assertState();
    }

    function rejectCorruption(uint8 field) external {
        bytes32 before_ = _fingerprint(account);
        T.SecurityPolicy memory next = _policy(alice, carol);
        T.SecurityChange memory change = _change(account, next, E.ChangeKind.Security);
        if (field % 4 == 0) change.accountId = bytes32(0);
        else if (field % 4 == 1) ++change.securityVersion;
        else if (field % 4 == 2) ++change.nonce;
        else change.previousManifestHash = bytes32(0);
        S.Signature[] memory auth =
            _votes(account.snapshot().policy, _context(account, change, E.ChangeKind.Security), P.ADMIN);
        (bool ok,) = address(account)
            .call(
                abi.encodeCall(
                    account.prepare,
                    (
                        E.ChangeKind.Security,
                        change,
                        next,
                        _chains(),
                        auth,
                        _proofs(account, next, change, E.ChangeKind.Security)
                    )
                )
            );
        assertFalse(ok);
        assertEq(_fingerprint(account), before_);
        ++rejected;
        assertState();
    }

    function assertState() public view {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        assertEq(state.admin, adminAccepted);
        assertEq(state.spend, 0);
        assertEq(state.version, 1 + installed);
        assertEq(T.hashPolicy(state.policy), expectedPolicy);
        assertEq(state.manifest, expectedManifest);
        assertEq(state.frozen, frozen);
        assertEq(state.scope, keccak256(abi.encode(_chains())));
        if (state.pending.kind != D.ProposalKind.None) {
            assertEq(state.pending.securityVersion, state.version);
            assertEq(state.pending.previousManifestHash, state.manifest);
            assertEq(state.pending.chainScopeHash, state.scope);
            assertLt(state.pending.readyAt, state.pending.validUntil);
            P.validate(state.pending.nextPolicy);
        } else {
            assertEq(state.pending.proposalHash, bytes32(0));
            assertEq(state.pending.nextPolicy.signers.length, 0);
        }
        (bool spending,) = address(account).staticcall(abi.encodeCall(account.spendEnabled, ()));
        assertTrue(spending);
    }
}

/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract AccountV3SecurityInvariantTest is Test {
    V3SecurityHandler private handler;
    V3SecurityHarness private account;
    V3SecurityInvariantToken private token;
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        handler = new V3SecurityHandler(V3SecurityHarness(address(0)));
        account = handler.account();
        token = new V3SecurityInvariantToken(address(account));
        vm.deal(address(account), 100 ether);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.prepare.selector;
        selectors[1] = handler.commitOrActivate.selector;
        selectors[2] = handler.cancel.selector;
        selectors[3] = handler.expire.selector;
        selectors[4] = handler.advance.selector;
        selectors[5] = handler.freeze.selector;
        selectors[6] = handler.rejectCorruption.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_authorityStateMatchesAcceptedOperations() public view {
        handler.assertState();
    }

    function invariant_securityCannotMoveAssetsOrUpgradeImplementation() public view {
        assertEq(address(account).balance, 100 ether);
        assertEq(token.balanceOf(address(account)), 100 ether);
        assertEq(token.allowance(address(account), address(handler)), 0);
        assertEq(vm.load(address(account), IMPLEMENTATION_SLOT), bytes32(0));
    }

    function test_handlerExercisesEverySuccessfulTransitionWithoutCheatStateWrites() public {
        handler.prepare(0, false);
        handler.commitOrActivate();
        handler.prepare(1, true);
        handler.advance(72 hours);
        handler.commitOrActivate();
        handler.prepare(2, false);
        handler.cancel(0);
        handler.prepare(2, true);
        handler.advance(11 days);
        handler.expire();
        handler.freeze();
        handler.rejectCorruption(0);
        assertEq(handler.installed(), 2);
        assertEq(handler.cancelled(), 1);
        assertEq(handler.expired(), 1);
        assertEq(handler.rejected(), 1);
        assertTrue(handler.frozen());
        handler.assertState();
        invariant_securityCannotMoveAssetsOrUpgradeImplementation();
    }
}
