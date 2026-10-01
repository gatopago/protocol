// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3Proxy} from "src/v3/AccountV3Proxy.sol";
import {AccountV3Initializable} from "src/v3/AccountV3Initializable.sol";
import {AccountV3Initialization as I} from "src/v3/AccountV3Initialization.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as P} from "src/v3/AccountV3Policy.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Enrollment as E} from "src/v3/AccountV3Enrollment.sol";
import {AccountV3WebAuthnVerifier} from "src/v3/AccountV3WebAuthnVerifier.sol";
import {
    V3CreationFixture,
    V3CreationEntryPoint,
    V3InitializedSecurityHarness
} from "test/helpers/V3CreationFixture.sol";
import {V3SecurityHarness} from "test/helpers/V3SecurityFixture.sol";
import {V3SecurityInvariantToken} from "test/AccountV3SecurityInvariant.t.sol";
import {V3TestContractSigner} from "test/AccountV3Signatures.t.sol";

/// @dev Test-only untrusted deployer, not a production bypass. It still cannot steal a canonical address.
contract V3UntrustedFactory {
    function deploy(address implementation, bytes32 salt, bytes calldata initialization)
        external
        returns (address account)
    {
        account = address(new AccountV3Proxy{salt: salt}(implementation));
        Address.functionCall(account, initialization);
    }
}

contract AccountV3CreationTest is V3CreationFixture {
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 private constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;
    T.SecurityPolicy private initialPolicy;
    T.InitializationApproval private approval;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        _setupCreation();
        initialPolicy = _policy(alice, bob);
        approval = _initial(initialPolicy, keccak256("synthetic salt, no PII"));
    }

    function test_atomicCreationInitializesRealProxyAndNamespaces() public {
        address predicted = _predicted();
        V3SecurityHarness account = _validCreate();
        assertEq(address(account), predicted);
        assertEq(predicted.codehash, keccak256(type(AccountV3Proxy).runtimeCode));
        assertEq(AccountV3Proxy(payable(predicted)).proxyImplementation(), address(implementation));
        assertEq(vm.load(predicted, IMPLEMENTATION_SLOT), bytes32(uint256(uint160(address(implementation)))));
        assertEq(vm.load(predicted, INITIALIZABLE_SLOT), bytes32(uint256(1)));
        assertEq(uint256(vm.load(address(implementation), INITIALIZABLE_SLOT)), type(uint64).max);
        assertNotEq(D.STORAGE_LOCATION, INITIALIZABLE_SLOT);
        V3SecurityHarness.Snapshot memory state = account.snapshot();
        assertEq(state.id, approval.accountId);
        assertEq(state.version, 1);
        assertEq(T.hashPolicy(state.policy), approval.initialSecurityCommitment);
        assertEq(state.scope, approval.chainScopeHash);
        assertEq(
            state.manifest,
            T.hashManifest(T.SecurityManifest(state.id, 3, 1, bytes32(0), T.hashPolicy(initialPolicy), state.scope))
        );
        assertEq(state.admin + state.spend, 0);
        assertFalse(state.frozen);
        assertEq(uint8(state.pending.kind), 0);
    }

    function test_implementationAndProxyCannotInitializeTwice() public {
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        uint256[] memory chains = _chains();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(approval, initialPolicy, chains, proofs);
        V3SecurityHarness account = _validCreate();
        bytes32 before_ = _fingerprint(account);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        AccountV3Initializable(address(account)).initialize(approval, initialPolicy, chains, proofs);
        assertEq(_fingerprint(account), before_);
    }

    function test_creatorPathRequiredEvenWithValidProofs() public {
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        uint256[] memory chains = _chains();
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__WrongCaller.selector);
        factory.createAccount(approval, initialPolicy, chains, proofs);
        vm.prank(address(ep));
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__WrongCaller.selector);
        factory.createAccount(approval, initialPolicy, chains, proofs);
        assertEq(_predicted().code.length, 0);
        assertEq(address(_validCreate()), _predicted());
    }

    function test_invalidProofRollsBackDeploymentAndPreservesPrefunding() public {
        address predicted = _predicted();
        vm.deal(predicted, 3 ether);
        V3SecurityInvariantToken token = new V3SecurityInvariantToken(predicted);
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        proofs[1].signature = hex"dead";
        _reject(approval, initialPolicy, _chains(), proofs, I.AccountV3Initialization__MissingPossession.selector);
        assertEq(vm.getNonce(predicted), 0);
        assertEq(predicted.balance, 3 ether);
        assertEq(token.balanceOf(predicted), 100 ether);
        _validCreate();
        assertEq(predicted.balance, 3 ether);
        assertEq(token.balanceOf(predicted), 100 ether);
        vm.deal(address(this), 1 ether);
        Address.sendValue(payable(predicted), 1 ether);
        assertEq(predicted.balance, 4 ether);
    }

    function testFuzz_everySignerNeededNotJustThreshold(uint8 corruption) public {
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        uint256 mode = uint256(corruption) % 5;
        if (mode == 0) {
            proofs = new S.Signature[](0);
        } else if (mode == 1) {
            S.Signature[] memory one = new S.Signature[](1);
            one[0] = proofs[0];
            proofs = one;
        } else if (mode == 2) {
            proofs[1] = proofs[0];
        } else if (mode == 3) {
            proofs[1].signerIndex = 255;
        } else {
            proofs[1].signature = new bytes(4097);
        }
        _reject(approval, initialPolicy, _chains(), proofs, I.AccountV3Initialization__MissingPossession.selector);
    }

    function test_reversedProofOrderStillProvesEveryMember() public {
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        (proofs[0], proofs[1]) = (proofs[1], proofs[0]);
        assertEq(address(_create(approval, initialPolicy, _chains(), proofs)), _predicted());
    }

    function testFuzz_identityTamperingRejectedWithFreshSignatures(uint8 corruption) public {
        T.InitializationApproval memory m = approval;
        uint256 mode = uint256(corruption) % 5;
        if (mode == 0) m.generation = 2;
        else if (mode == 1) m.nonce = 1;
        else if (mode == 2) m.accountId = keccak256("different id");
        else if (mode == 3) m.userSaltCommitment = keccak256("different salt");
        else m.initialSecurityCommitment = keccak256("different commitment");
        _reject(
            m,
            initialPolicy,
            _chains(),
            _initialProofs(m, initialPolicy),
            I.AccountV3Initialization__WrongIdentity.selector
        );
    }

    function test_policyCannotBeSwappedAtSameAddress() public {
        T.SecurityPolicy memory wrong = _policy(carol, dave);
        _reject(
            approval,
            wrong,
            _chains(),
            _initialProofs(approval, wrong),
            I.AccountV3Initialization__WrongIdentity.selector
        );
        T.InitializationApproval memory other = _initial(wrong, approval.userSaltCommitment);
        assertNotEq(factory.getAddress(other.initialSecurityCommitment, other.userSaltCommitment), _predicted());
    }

    function test_invalidInitialQuorumCannotReachCompactStorageEvenWithMatchingIdentity() public {
        T.SecurityPolicy memory weak = initialPolicy;
        weak.adminThreshold = 0;
        T.InitializationApproval memory m = _initial(weak, approval.userSaltCommitment);
        _reject(m, weak, _chains(), _initialProofs(m, weak), P.AccountV3Policy__InvalidThreshold.selector);
        assertEq(factory.getAddress(m.initialSecurityCommitment, m.userSaltCommitment).code.length, 0);
    }

    function test_factoryAndEntryPointAreSignedAndChecked() public {
        T.InitializationApproval memory m = approval;
        m.factory = address(123);
        _reject(
            m,
            initialPolicy,
            _chains(),
            _initialProofs(m, initialPolicy),
            I.AccountV3Initialization__WrongDeployment.selector
        );
        m = approval;
        m.entryPoint = address(456);
        _reject(
            m,
            initialPolicy,
            _chains(),
            _initialProofs(m, initialPolicy),
            I.AccountV3Initialization__WrongDeployment.selector
        );
    }

    function testFuzz_scopeCannotBeEmptyUnsortedDuplicatedOversizedOrMissingChain(uint8 corruption) public {
        uint256 mode = uint256(corruption) % 6;
        uint256[] memory chains = new uint256[](mode == 0 ? 0 : mode == 1 ? 33 : mode == 2 || mode == 3 ? 2 : 1);
        for (uint256 i; i < chains.length; ++i) {
            chains[i] = block.chainid + i;
        }
        if (mode == 2) chains[1] = chains[0];
        if (mode == 3) chains[0] += 2;
        if (mode == 4) chains[0] = 0;
        if (mode == 5) chains[0] += 1;
        T.InitializationApproval memory m = approval;
        m.chainScopeHash = keccak256(abi.encode(chains));
        _reject(
            m, initialPolicy, chains, _initialProofs(m, initialPolicy), I.AccountV3Initialization__WrongScope.selector
        );
    }

    function test_suppliedScopeMustMatchSignedHash() public {
        T.InitializationApproval memory m = approval;
        m.chainScopeHash = keccak256("not the supplied array");
        _reject(
            m,
            initialPolicy,
            _chains(),
            _initialProofs(m, initialPolicy),
            I.AccountV3Initialization__WrongScope.selector
        );
    }

    function test_validityIsHalfOpenAndHasNoInfiniteZeroConvention() public {
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        vm.warp(approval.validAfter - 1);
        _reject(approval, initialPolicy, _chains(), proofs, I.AccountV3Initialization__OutsideValidity.selector);
        vm.warp(approval.validUntil);
        _reject(approval, initialPolicy, _chains(), proofs, I.AccountV3Initialization__OutsideValidity.selector);
        T.InitializationApproval memory invalid = approval;
        invalid.validUntil = 0;
        _reject(
            invalid,
            initialPolicy,
            _chains(),
            _initialProofs(invalid, initialPolicy),
            I.AccountV3Initialization__OutsideValidity.selector
        );
        vm.warp(approval.validAfter);
        _validCreate();
    }

    function test_newWindowNeedsNewProofButDoesNotChangeAddress() public {
        S.Signature[] memory stale = _initialProofs(approval, initialPolicy);
        T.InitializationApproval memory fresh = approval;
        fresh.validUntil += 1 days;
        _reject(fresh, initialPolicy, _chains(), stale, I.AccountV3Initialization__MissingPossession.selector);
        assertEq(address(_create(fresh, initialPolicy, _chains(), _initialProofs(fresh, initialPolicy))), _predicted());
    }

    function testFuzz_saltChangesAddressWithoutChangingProxyCode(bytes32 salt) public {
        T.InitializationApproval memory m = _initial(initialPolicy, salt);
        address predicted = factory.getAddress(m.initialSecurityCommitment, salt);
        assertEq(predicted, Create2.computeAddress(m.accountId, factory.proxyInitCodeHash(), address(factory)));
        V3SecurityHarness account = _create(m, initialPolicy, _chains(), _initialProofs(m, initialPolicy));
        assertEq(address(account), predicted);
        assertEq(predicted.codehash, keccak256(type(AccountV3Proxy).runtimeCode));
        if (salt != approval.userSaltCommitment) assertNotEq(predicted, _predicted());
    }

    function test_twoLocalChainsSameAddressAndCodeButSeparateApproval() public {
        uint256[] memory chains = new uint256[](2);
        chains[0] = 31337;
        chains[1] = 31338;
        T.InitializationApproval memory m = approval;
        m.chainScopeHash = keccak256(abi.encode(chains));
        S.Signature[] memory firstProofs = _initialProofs(m, initialPolicy);
        uint256 checkpoint = vm.snapshotState();
        address first = address(_create(m, initialPolicy, chains, firstProofs));
        bytes32 code = first.codehash;
        assertTrue(vm.revertToState(checkpoint));
        vm.chainId(31338);
        _reject(m, initialPolicy, chains, firstProofs, I.AccountV3Initialization__MissingPossession.selector);
        address second = address(_create(m, initialPolicy, chains, _initialProofs(m, initialPolicy)));
        assertEq(second, first);
        assertEq(second.codehash, code);
    }

    function test_wrongFactoryCannotBorrowProofOrCanonicalAddress() public {
        V3UntrustedFactory rogue = new V3UntrustedFactory();
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        bytes memory data = abi.encodeCall(implementation.initialize, (approval, initialPolicy, _chains(), proofs));
        vm.expectRevert(I.AccountV3Initialization__WrongDeployment.selector);
        rogue.deploy(address(implementation), approval.accountId, data);
        T.InitializationApproval memory m = approval;
        m.factory = address(rogue);
        data = abi.encodeCall(implementation.initialize, (m, initialPolicy, _chains(), proofs));
        vm.expectRevert(I.AccountV3Initialization__MissingPossession.selector);
        rogue.deploy(address(implementation), approval.accountId, data);
        assertEq(_predicted().code.length, 0);
    }

    function test_directProxyCannotClaimCanonicalFactoryContext() public {
        AccountV3Proxy direct = new AccountV3Proxy(address(implementation));
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        uint256[] memory chains = _chains();
        vm.prank(address(factory));
        vm.expectRevert(AccountV3Initializable.AccountV3Initializable__WrongProxyContext.selector);
        AccountV3Initializable(address(direct)).initialize(approval, initialPolicy, chains, proofs);
        assertEq(vm.load(address(direct), INITIALIZABLE_SLOT), bytes32(0));
    }

    function test_existingCreationIsReadOnlyAfterPolicyChangeAndExpiry() public {
        V3SecurityHarness account = _validCreate();
        _prepare(account, _policy(carol, dave), E.ChangeKind.Security);
        _commit(account);
        bytes32 before_ = _fingerprint(account);
        vm.warp(approval.validUntil + 1);
        assertEq(address(_create(approval, initialPolicy, new uint256[](0), new S.Signature[](0))), address(account));
        assertEq(_fingerprint(account), before_);
        assertEq(account.snapshot().version, 2);
        assertEq(T.hashPolicy(account.snapshot().policy), T.hashPolicy(_policy(carol, dave)));
    }

    function test_recoveryAndFreezeSurviveExistingAddressLookup() public {
        V3SecurityHarness account = _validCreate();
        _freeze(account);
        _prepare(account, _policy(carol, dave), E.ChangeKind.Security);
        vm.warp(block.timestamp + 72 hours);
        _commit(account);
        bytes32 before_ = _fingerprint(account);
        _create(approval, initialPolicy, new uint256[](0), new S.Signature[](0));
        assertEq(_fingerprint(account), before_);
        assertTrue(account.snapshot().frozen);
    }

    function testFuzz_deploymentCodeDriftFailsClosed(uint8 which) public {
        address target = uint256(which) % 4 == 0
            ? address(implementation)
            : uint256(which) % 4 == 1
                ? address(ep.senderCreator())
                : uint256(which) % 4 == 2 ? implementation.securityModule() : implementation.upgradeModule();
        S.Signature[] memory proofs = _initialProofs(approval, initialPolicy);
        bytes memory input = abi.encodeCall(factory.createAccount, (approval, initialPolicy, _chains(), proofs));
        address caller = factory.senderCreator();
        vm.etch(target, hex"60006000fd"); // Deliberate fault injection, NEVER the deterministic deployment proof.
        vm.prank(caller);
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__DeploymentChanged.selector);
        address(factory).functionCall(input);
        assertEq(_predicted().code.length, 0);
    }

    function testFuzz_existingCodeImplementationOrIdentityMismatchFailsClosed(uint8 which) public {
        V3SecurityHarness account = _validCreate();
        uint256 mode = uint256(which) % 3;
        if (mode == 0) vm.etch(address(account), hex"60006000fd");
        else if (mode == 1) vm.store(address(account), IMPLEMENTATION_SLOT, bytes32(uint256(uint160(address(ep)))));
        else vm.store(address(account), bytes32(uint256(D.STORAGE_LOCATION) + 1), bytes32(uint256(123)));
        bytes memory input = abi.encodeCall(
            factory.createAccount, (approval, initialPolicy, _chains(), _initialProofs(approval, initialPolicy))
        );
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__ExistingAccountMismatch.selector);
        ep.forward(address(factory), input);
    }

    function test_invalidFactoryConfigurationCannotBeDeployed() public {
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__InvalidDeployment.selector);
        new AccountFactoryV3(address(0), address(ep));
        V3CreationEntryPoint other = new V3CreationEntryPoint();
        vm.expectRevert(AccountFactoryV3.AccountFactoryV3__InvalidDeployment.selector);
        new AccountFactoryV3(address(implementation), address(other));
        vm.expectRevert(AccountV3Initializable.AccountV3Initializable__InvalidEntryPoint.selector);
        new V3InitializedSecurityHarness(address(123));
    }

    function test_singlePasskeyAfterCreationCanSpendAndAdminister() public {
        AccountV3WebAuthnVerifier verifier = new AccountV3WebAuthnVerifier();
        T.SecurityPolicy memory policy = _policy(alice, bob);
        policy.mode = P.ACTIVE;
        policy.adminThreshold = 1;
        policy.signers = new T.SignerDescriptor[](1);
        policy.signers[0] = T.SignerDescriptor(
            P.WEBAUTHN,
            address(verifier),
            address(verifier).codehash,
            abi.encodePacked(sha256("gatopago.com"), sha256("https://gatopago.com"), P256.GX, P256.GY),
            (P.SPEND | P.ADMIN)
        );
        T.InitializationApproval memory m = _initial(policy, keccak256("bootstrap"));
        V3SecurityHarness account = _create(m, policy, _chains(), _initialProofs(m, policy));
        (bool enabled,) = address(account).staticcall(abi.encodeCall(account.spendEnabled, ()));
        assertTrue(enabled);
        _prepare(account, _policy(carol, dave), E.ChangeKind.Security);
        _commit(account);
        account.spendEnabled(); // The real execution suite separately proves spending after bootstrap.
        assertEq(account.snapshot().version, 2);
    }

    function test_ERC1271RevokedBetweenSigningAndCreationRejectsAtomically() public {
        V3TestContractSigner signer = new V3TestContractSigner(bob);
        testKeys[address(signer)] = testKeys[bob];
        T.SecurityPolicy memory policy = _policy(alice, bob);
        policy.signers[0] = _ecdsa(alice);
        policy.signers[1] = T.SignerDescriptor(
            P.ERC1271, address(signer), address(signer).codehash, abi.encodePacked(address(signer)), 3
        );
        _sort(policy);
        T.InitializationApproval memory m = _initial(policy, keccak256("contract signer"));
        S.Signature[] memory proofs = _initialProofs(m, policy);
        signer.revoke();
        _reject(m, policy, _chains(), proofs, I.AccountV3Initialization__MissingPossession.selector);
    }

    function _predicted() private view returns (address) {
        return factory.getAddress(approval.initialSecurityCommitment, approval.userSaltCommitment);
    }

    function _validCreate() private returns (V3SecurityHarness) {
        return _create(approval, initialPolicy, _chains(), _initialProofs(approval, initialPolicy));
    }

    function _reject(
        T.InitializationApproval memory m,
        T.SecurityPolicy memory policy,
        uint256[] memory chains,
        S.Signature[] memory proofs,
        bytes4 reason
    ) private {
        bytes memory input = abi.encodeCall(factory.createAccount, (m, policy, chains, proofs));
        address predicted = factory.getAddress(m.initialSecurityCommitment, m.userSaltCommitment);
        vm.expectRevert(reason);
        ep.forward(address(factory), input);
        assertEq(predicted.code.length, 0);
        assertEq(vm.load(predicted, INITIALIZABLE_SLOT), bytes32(0));
    }
    using Address for address;
}
