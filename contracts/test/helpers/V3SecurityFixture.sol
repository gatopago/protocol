// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";

/// @dev Test harness ONLY. Constructor seeds a namespace; it does NOT prove factory/4337 initialization.
/// No implementation/factory/account deployment script may import this file.
contract V3SecurityHarness {
    struct Snapshot {
        bool frozen;
        uint64 version;
        bytes32 id;
        bytes32 manifest;
        bytes32 scope;
        uint256 admin;
        uint256 spend;
        T.SecurityPolicy policy;
        D.PendingProposal pending;
    }

    constructor(T.SecurityPolicy memory policy, bytes32 scope) {
        P.validate(policy);
        D.Layout storage state = D.layout();
        state.initialized = true;
        state.generation = 3;
        state.securityVersion = 1;
        state.initialSecurityCommitment = T.hashPolicy(policy);
        state.userSaltCommitment = keccak256("security-fixture-salt");
        state.chainScopeHash = scope;
        state.manifestHash =
            T.hashManifest(T.SecurityManifest(D.accountId(state), 3, 1, bytes32(0), T.hashPolicy(policy), scope));
        PS.store(state.policy, policy);
    }

    function prepare(
        E.ChangeKind kind,
        T.SecurityChange memory message,
        T.SecurityPolicy memory next,
        uint256[] calldata chains,
        S.Signature[] memory auth,
        S.Signature[] memory proofs
    ) external returns (bytes32) {
        return Security.prepare(kind, message, next, chains, auth, proofs);
    }

    function commit(T.CommitProposal memory message, S.Signature[] memory auth) external {
        Security.commitPolicy(message, auth);
    }

    function cancel(T.CancelProposal memory message, S.Signature[] memory signatures) external {
        Security.cancel(message, signatures);
    }

    function freeze(T.FreezeUpgrades memory message, uint256[] calldata chains, S.Signature[] memory auth) external {
        Security.freezeUpgrades(message, chains, auth);
    }

    function expire(bytes32 proposal) external {
        Security.expire(proposal);
    }

    function spendEnabled() external view {
        Security.requireSpendEnabled();
    }

    function snapshot() external view returns (Snapshot memory) {
        D.Layout storage s = D.layout();
        return Snapshot(
            s.upgradesFrozen,
            s.securityVersion,
            D.accountId(s),
            s.manifestHash,
            s.chainScopeHash,
            s.adminNonce,
            s.spendNonce,
            PS.load(s.policy),
            s.pending
        );
    }
}

/// @dev Only unit tests use deliberately corrupted/edge-state fixtures. NEVER an invariant fuzz target.
contract V3SecurityEdgeHarness is V3SecurityHarness {
    constructor(T.SecurityPolicy memory policy, bytes32 scope) V3SecurityHarness(policy, scope) {}

    function seedHeader(bool initialized, bool executing, uint64 version) external {
        D.Layout storage state = D.layout();
        state.initialized = initialized;
        state.executing = executing;
        state.securityVersion = version;
    }

    function seedNonces(uint256 admin) external {
        D.Layout storage state = D.layout();
        state.adminNonce = admin;
    }

    function seedUpgrade() external {
        D.Layout storage state = D.layout();
        state.pending.kind = D.ProposalKind.Upgrade;
        state.pending.securityVersion = state.securityVersion;
        state.pending.previousManifestHash = state.manifestHash;
        state.pending.proposalHash = keccak256("seeded-upgrade-NOT-real-upgrade-proof");
        state.pending.chainScopeHash = state.chainScopeHash;
        state.pending.validUntil = type(uint48).max;
        state.pending.upgrade.runtimeCodeHash = keccak256("must-not-survive-cancellation");
    }
}

abstract contract V3SecurityFixture is Test {
    mapping(address signer => uint256 scalar) internal testKeys;
    address internal alice;
    address internal bob;
    address internal carol;
    address internal dave;

    function _setupKeys() internal {
        // Ephemeral synthetic test keys, never read from config, persisted or used on a network.
        uint256 scalar;
        (alice, scalar) = makeAddrAndKey("v3-security-fixture-alice");
        testKeys[alice] = scalar;
        (bob, scalar) = makeAddrAndKey("v3-security-fixture-bob");
        testKeys[bob] = scalar;
        (carol, scalar) = makeAddrAndKey("v3-security-fixture-carol");
        testKeys[carol] = scalar;
        (dave, scalar) = makeAddrAndKey("v3-security-fixture-dave");
        testKeys[dave] = scalar;
    }

    function _policy(address a, address b) internal pure returns (T.SecurityPolicy memory policy) {
        policy.mode = P.ACTIVE;
        policy.signers = new T.SignerDescriptor[](2);
        policy.signers[0] = _ecdsa(a);
        policy.signers[1] = _ecdsa(b);
        policy.spendThreshold = 1;
        policy.adminThreshold = 2;
        policy.upgradeDelaySeconds = 72 hours;
        _sort(policy);
    }

    function _ecdsa(address key) internal pure returns (T.SignerDescriptor memory) {
        return T.SignerDescriptor(P.ECDSA, address(0), bytes32(0), abi.encodePacked(key), 3);
    }

    function _sort(T.SecurityPolicy memory policy) internal pure {
        for (uint256 i = 1; i < policy.signers.length; ++i) {
            for (uint256 j = i; j > 0 && T.signerId(policy.signers[j - 1]) > T.signerId(policy.signers[j]); --j) {
                T.SignerDescriptor memory old = policy.signers[j - 1];
                policy.signers[j - 1] = policy.signers[j];
                policy.signers[j] = old;
            }
        }
    }

    function _chains() internal view returns (uint256[] memory chains) {
        chains = new uint256[](1);
        chains[0] = block.chainid;
    }

    function _change(
        V3SecurityHarness account,
        T.SecurityPolicy memory next,
        E.ChangeKind /* kind */
    )
        internal
        view
        returns (T.SecurityChange memory)
    {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        return T.SecurityChange(
            state.id,
            3,
            state.version,
            state.manifest,
            T.hashPolicy(next),
            keccak256(abi.encode(_chains())),
            state.admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes),
            SafeCast.toUint48(block.timestamp + 7 days)
        );
    }

    function _context(V3SecurityHarness account, T.SecurityChange memory change, E.ChangeKind kind)
        internal
        view
        returns (bytes32)
    {
        bytes32 h = E.hashChange(kind, change);
        return T.digest(block.chainid, address(account), h);
    }

    function _votes(T.SecurityPolicy memory policy, bytes32 digest, uint8 role)
        internal
        view
        returns (S.Signature[] memory votes)
    {
        uint256 count;
        for (uint256 i; i < policy.signers.length; ++i) {
            if ((policy.signers[i].roles & role) != 0) ++count;
        }
        votes = new S.Signature[](count);
        uint256 j;
        for (uint256 i; i < policy.signers.length; ++i) {
            if ((policy.signers[i].roles & role) != 0) {
                votes[j++] = S.Signature(SafeCast.toUint8(i), _memberSign(policy.signers[i], digest));
            }
        }
    }

    function _proofs(
        V3SecurityHarness account,
        T.SecurityPolicy memory next,
        T.SecurityChange memory change,
        E.ChangeKind kind
    ) internal view returns (S.Signature[] memory proofs) {
        T.SecurityPolicy memory previous = account.snapshot().policy;
        S.Signature[] memory buffer = new S.Signature[](next.signers.length);
        uint256 count;
        for (uint256 i; i < next.signers.length; ++i) {
            T.SignerDescriptor memory member = next.signers[i];
            bool same;
            for (uint256 j; j < previous.signers.length; ++j) {
                T.SignerDescriptor memory old = previous.signers[j];
                if (T.signerId(old) == T.signerId(member) && old.roles == member.roles) same = true;
            }
            if (same) continue;
            T.EnrollmentProof memory proof = T.EnrollmentProof(
                change.accountId,
                3,
                change.securityVersion,
                T.signerId(member),
                change.nextPolicyHash,
                _context(account, change, kind),
                change.nonce,
                change.validAfter,
                change.validUntil
            );
            buffer[count++] = S.Signature(
                SafeCast.toUint8(i),
                _memberSign(member, T.digest(block.chainid, address(account), T.hashEnrollment(proof)))
            );
        }
        proofs = new S.Signature[](count);
        for (uint256 i; i < count; ++i) {
            proofs[i] = buffer[i];
        }
    }

    function _prepare(V3SecurityHarness account, T.SecurityPolicy memory next, E.ChangeKind kind)
        internal
        returns (bytes32)
    {
        T.SecurityChange memory change = _change(account, next, kind);
        uint8 role = P.ADMIN;
        S.Signature[] memory auth = _votes(account.snapshot().policy, _context(account, change, kind), role);
        S.Signature[] memory proofs = _proofs(account, next, change, kind);
        return account.prepare(kind, change, next, _chains(), auth, proofs);
    }

    function _commitMessage(V3SecurityHarness account) internal view returns (T.CommitProposal memory message) {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        uint48 until = SafeCast.toUint48(block.timestamp + 5 minutes);
        // Synthetic clock selects a test validity boundary, not randomness or production finality.
        // forge-lint: disable-next-line(block-timestamp)
        if (state.pending.validUntil > block.timestamp && state.pending.validUntil < until) {
            until = state.pending.validUntil;
        }
        message = T.CommitProposal(
            state.id,
            3,
            state.version,
            state.manifest,
            state.pending.proposalHash,
            keccak256("fixture acknowledgement, not remote finality"),
            state.pending.chainScopeHash,
            state.admin,
            SafeCast.toUint48(block.timestamp),
            until
        );
    }

    function _commit(V3SecurityHarness account) internal {
        T.CommitProposal memory message = _commitMessage(account);
        T.SecurityPolicy memory policy = account.snapshot().policy;
        account.commit(
            message, _votes(policy, T.digest(block.chainid, address(account), T.hashCommit(message)), P.ADMIN)
        );
    }

    function _cancelMessage(V3SecurityHarness account) internal view returns (T.CancelProposal memory) {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        return T.CancelProposal(
            state.id,
            3,
            state.version,
            state.pending.proposalHash,
            state.admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 5 minutes)
        );
    }

    function _cancel(V3SecurityHarness account) internal {
        T.CancelProposal memory message = _cancelMessage(account);
        account.cancel(
            message,
            _votes(account.snapshot().policy, T.digest(block.chainid, address(account), T.hashCancel(message)), P.ADMIN)
        );
    }

    function _freezeMessage(V3SecurityHarness account) internal view returns (T.FreezeUpgrades memory) {
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        return T.FreezeUpgrades(
            state.id,
            3,
            state.version,
            state.manifest,
            keccak256(abi.encode(_chains())),
            state.admin,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 1 days)
        );
    }

    function _freeze(V3SecurityHarness account) internal {
        T.FreezeUpgrades memory message = _freezeMessage(account);
        account.freeze(
            message,
            _chains(),
            _votes(account.snapshot().policy, T.digest(block.chainid, address(account), T.hashFreeze(message)), P.ADMIN)
        );
    }

    function _memberSign(T.SignerDescriptor memory member, bytes32 digest) internal view returns (bytes memory) {
        if (member.kind == P.WEBAUTHN) return _webSign(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(testKeys[address(bytes20(member.key))], digest);
        return abi.encodePacked(r, s, v);
    }

    function _webSign(bytes32 digest) internal pure returns (bytes memory) {
        // Public mathematical test vector scalar 1, NOT a deployed/user passkey.
        bytes memory data = abi.encodePacked(sha256("gatopago.com"), bytes1(0x05), bytes4(0));
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://gatopago.com","crossOrigin":false}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(1, sha256(abi.encodePacked(data, sha256(bytes(json)))));
        if (uint256(s) > P256.N / 2) s = bytes32(P256.N - uint256(s));
        return abi.encode(r, s, uint256(23), uint256(1), data, json);
    }

    function _fingerprint(V3SecurityHarness account) internal view returns (bytes32) {
        return keccak256(abi.encode(account.snapshot()));
    }
}
