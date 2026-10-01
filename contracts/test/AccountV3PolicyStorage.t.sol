// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3PolicyStorage as PS} from "src/v3/AccountV3PolicyStorage.sol";
import {AccountV3Validity as V} from "src/v3/AccountV3Validity.sol";
import {V3SecurityFixture} from "test/helpers/V3SecurityFixture.sol";

/// @dev Unrestricted STORAGE TEST fixture, never a deployable wallet or signer verifier.
contract V3PolicyStorageHarness {
    function store(T.SecurityPolicy memory policy) external {
        PS.store(D.layout().policy, policy);
    }

    function recordWindow(uint48 after_, uint48 until_) external {
        V.recordCreation(after_, until_);
    }

    function consumeWindow(uint256 data) external returns (uint256) {
        return V.consumeCreation(data);
    }

    function seedHeader() external {
        D.Layout storage state = D.layout();
        state.generation = 3;
        state.initialized = true;
        state.upgradesFrozen = true;
        state.securityVersion = type(uint64).max;
        state.executing = true;
    }

    function corruptSigner(uint8 kind, bytes32 hash, bytes memory key) external {
        D.StoredSigner storage signer = D.layout().policy.signers[0];
        signer.kind = kind;
        signer.verifierCodeHash = hash;
        signer.key = key;
    }

    function load() external view returns (T.SecurityPolicy memory) {
        return PS.load(D.layout().policy);
    }

    function storedSigner(uint256 index) external view returns (D.StoredSigner memory) {
        return D.layout().policy.signers[index];
    }

    function window() external view returns (uint256) {
        return V.creationData();
    }
}

contract AccountV3PolicyStorageTest is V3SecurityFixture {
    V3PolicyStorageHarness internal harness;

    function setUp() public {
        harness = new V3PolicyStorageHarness();
    }

    function testFuzz_roundTripAllSignerKinds(uint8 countSeed, bytes32 seed, bool variation) public {
        _roundTrip(_mixed(bound(countSeed, 2, 16), seed, variation));
    }

    function test_roundTripMaximumSixteenSigners() public {
        _roundTrip(_mixed(16, keccak256("maximum"), true));
    }

    function test_bootstrapWebAuthnPreservesAllKeyWords() public {
        T.SecurityPolicy memory policy = _mixed(5, keccak256("bootstrap"), false);
        T.SignerDescriptor memory signer;
        for (uint256 i; i < policy.signers.length; ++i) {
            if (policy.signers[i].kind == P.WEBAUTHN) signer = policy.signers[i];
        }
        signer.roles = P.SPEND | P.ADMIN;
        policy.mode = P.ACTIVE;
        policy.signers = new T.SignerDescriptor[](1);
        policy.signers[0] = signer;
        policy.adminThreshold = 1;
        _roundTrip(policy);
    }

    function test_highBitAddressKeysKeepAllTwentyBytes() public {
        _roundTrip(_policy(address(type(uint160).max), address(uint160(1) << 159)));
    }

    function test_replacingLongKeysAndShrinkingClearsEveryOldStorageWord() public {
        T.SecurityPolicy memory before_ = _mixed(16, keccak256("old key material"), true);
        harness.store(before_);
        // Compiler-derived layout: policy header at root+9, signers anchor root+10,
        // each StoredSigner uses three words. The layout guard also commits these offsets.
        uint256 start = uint256(keccak256(abi.encode(uint256(D.STORAGE_LOCATION) + 8)));
        bytes32[] memory oldKeyRoots = new bytes32[](16);
        for (uint256 i; i < before_.signers.length; ++i) {
            if (before_.signers[i].kind == P.WEBAUTHN) {
                oldKeyRoots[i] = keccak256(abi.encode(start + i * 3 + 2));
                assertNotEq(vm.load(address(harness), oldKeyRoots[i]), bytes32(0));
            }
        }
        T.SecurityPolicy memory next = _policy(address(0x1234), address(0x5678));
        _roundTrip(next);
        for (uint256 i; i < 16; ++i) {
            if (oldKeyRoots[i] != bytes32(0)) {
                for (uint256 j; j < 4; ++j) {
                    assertEq(vm.load(address(harness), bytes32(uint256(oldKeyRoots[i]) + j)), bytes32(0));
                }
            }
            if (i >= 2) {
                for (uint256 j; j < 3; ++j) {
                    assertEq(vm.load(address(harness), bytes32(start + i * 3 + j)), bytes32(0));
                }
            }
        }
        _roundTrip(before_); // Regrowing must explicitly install, not inherit, every field.
        _roundTrip(next);
    }

    function testFuzz_rejectAmbiguousDescriptorsBeforeWriting(uint8 mutation) public {
        T.SecurityPolicy memory previous = _policy(address(1), address(2));
        harness.store(previous);
        T.SecurityPolicy memory invalid = _policy(address(3), address(4));
        mutation = SafeCast.toUint8(bound(mutation, 0, 6));
        if (mutation == 0) {
            invalid.signers[0].verifier = address(5);
        } else if (mutation == 1) {
            invalid.signers[0].verifierCodeHash = bytes32(uint256(1));
        } else if (mutation == 2) {
            invalid.signers[0].key = abi.encodePacked(address(6), bytes1(0x01));
        } else if (mutation == 3) {
            invalid.signers[0].kind = P.ERC1271;
            invalid.signers[0].verifier = address(7);
            invalid.signers[0].verifierCodeHash = bytes32(uint256(1));
        } else if (mutation == 4) {
            invalid.signers[0].roles = 8;
        } else if (mutation == 5) {
            invalid.signers[0].roles = 0;
        } else {
            invalid.signers[0].kind = 3;
        }
        vm.expectRevert(P.AccountV3Policy__InvalidSigner.selector);
        harness.store(invalid);
        assertEq(abi.encode(harness.load()), abi.encode(previous));
    }

    function test_rejectEmptyOversizedAndWeakPolicyWithoutChangingState() public {
        T.SecurityPolicy memory previous = _policy(address(1), address(2));
        harness.store(previous);
        T.SecurityPolicy memory invalid = _mixed(17, keccak256("oversized"), false);
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        harness.store(invalid);
        invalid.signers = new T.SignerDescriptor[](0);
        vm.expectRevert(P.AccountV3Policy__InvalidPolicy.selector);
        harness.store(invalid);
        invalid = _policy(address(3), address(4));
        invalid.adminThreshold = 0;
        vm.expectRevert(P.AccountV3Policy__InvalidThreshold.selector);
        harness.store(invalid);
        assertEq(abi.encode(harness.load()), abi.encode(previous));
    }

    function test_inactiveUnionWordsCannotChangeAuthorityAndUnknownKindFailsClosed() public {
        T.SecurityPolicy memory policy = _policy(address(1), address(2));
        harness.store(policy);
        harness.corruptSigner(P.ECDSA, bytes32(uint256(1)), hex"");
        assertEq(abi.encode(harness.load()), abi.encode(policy));
        harness.corruptSigner(P.ECDSA, bytes32(0), hex"1234");
        assertEq(abi.encode(harness.load()), abi.encode(policy));
        harness.corruptSigner(3, bytes32(0), hex"");
        vm.expectRevert(PS.AccountV3PolicyStorage__InvalidStoredSigner.selector);
        harness.load();
    }

    function testFuzz_creationWindowPreservesHeaderAndPolicy(uint48 after_, uint48 duration) public {
        after_ = SafeCast.toUint48(bound(after_, 1, V.MAX_TIMESTAMP - 1));
        uint48 until_ = after_ + SafeCast.toUint48(bound(duration, 1, V.MAX_TIMESTAMP - after_));
        T.SecurityPolicy memory policy = _policy(address(1), address(2));
        harness.store(policy);
        harness.recordWindow(after_, until_);
        harness.seedHeader();
        uint256 header = uint256(3) | (uint256(1) << 32) | (uint256(1) << 40) | (uint256(type(uint64).max) << 48)
            | (uint256(1) << 112);
        assertEq(
            vm.load(address(harness), D.STORAGE_LOCATION),
            bytes32(header | (uint256(after_) << 120) | (uint256(until_) << 168))
        );
        uint256 expected = ERC4337Utils.packValidationData(true, after_ - 1, until_ - 1);
        assertEq(harness.window(), expected);
        assertEq(harness.consumeWindow(expected), expected);
        assertEq(harness.window(), 0);
        assertEq(vm.load(address(harness), D.STORAGE_LOCATION), bytes32(header));
        assertEq(abi.encode(harness.load()), abi.encode(policy));
        assertEq(harness.consumeWindow(1), 1); // No stale creation window after consumption.
    }

    function test_invalidCreationWindowDoesNotOverwritePendingWindow() public {
        harness.recordWindow(1, 2);
        uint256 previous = harness.window();
        vm.expectRevert(V.AccountV3Validity__InvalidWindow.selector);
        harness.recordWindow(0, 2);
        vm.expectRevert(V.AccountV3Validity__InvalidWindow.selector);
        harness.recordWindow(2, 2);
        vm.expectRevert(V.AccountV3Validity__InvalidWindow.selector);
        harness.recordWindow(1, V.MAX_TIMESTAMP + 1);
        assertEq(harness.window(), previous);
    }

    function _roundTrip(T.SecurityPolicy memory policy) internal {
        harness.store(policy);
        T.SecurityPolicy memory loaded = harness.load();
        assertEq(abi.encode(loaded), abi.encode(policy));
        assertEq(T.hashPolicy(loaded), T.hashPolicy(policy));
        P.validate(loaded);
        for (uint256 i; i < policy.signers.length; ++i) {
            assertEq(T.signerId(loaded.signers[i]), T.signerId(policy.signers[i]));
            D.StoredSigner memory stored = harness.storedSigner(i);
            assertEq(stored.key.length, policy.signers[i].kind == P.WEBAUTHN ? 128 : 0);
            assertEq(
                stored.identity,
                policy.signers[i].kind == P.ECDSA ? address(bytes20(policy.signers[i].key)) : policy.signers[i].verifier
            );
        }
    }

    function _mixed(uint256 count, bytes32 seed, bool /* variation */) internal pure returns (T.SecurityPolicy memory p) {
        p = _policy(address(1), address(2));
        p.signers = new T.SignerDescriptor[](count);
        for (uint256 i; i < count; ++i) {
            address identity = address(uint160(uint256(keccak256(abi.encode(seed, i)))) | uint160(1));
            p.signers[i] = _ecdsa(identity);
            if (i >= 2) {
                p.signers[i].kind = SafeCast.toUint8(i % 3);
                p.signers[i].roles = SafeCast.toUint8(1 + uint256(keccak256(abi.encode(i, seed))) % 3);
                if (p.signers[i].kind != P.ECDSA) {
                    p.signers[i].verifier = identity;
                    p.signers[i].verifierCodeHash = keccak256(abi.encode(seed, i, "verifier"));
                }
                if (p.signers[i].kind == P.WEBAUTHN) {
                    // Opaque nonzero structural bytes: storage test, NOT P256 possession proof.
                    p.signers[i].key = abi.encode(seed, i, keccak256(abi.encode(seed, i)), bytes32(uint256(1)));
                }
            }
        }
        _sort(p);
    }
}
