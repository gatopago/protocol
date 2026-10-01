// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccountV3Proxy} from "src/v3/AccountV3Proxy.sol";
import {AccountV3Initializable} from "src/v3/AccountV3Initializable.sol";
import {AccountV3SecurityModule} from "src/v3/AccountV3SecurityModule.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {V3CreationFixture} from "test/helpers/V3CreationFixture.sol";
import {V3SecurityHarness} from "test/helpers/V3SecurityFixture.sol";
import {V3SecurityHandler, V3SecurityInvariantToken} from "test/AccountV3SecurityInvariant.t.sol";

/// @dev Same authority state-machine fuzzer, now on a genuinely deployed/initialized proxy.
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract AccountV3CreationInvariantTest is V3CreationFixture {
    V3SecurityHandler private handler;
    V3SecurityHarness private account;
    V3SecurityInvariantToken private token;
    T.InitializationApproval private initial;
    T.SecurityPolicy private policy;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        _setupCreation();
        policy = _policy(alice, bob);
        initial = _initial(policy, keccak256("creation invariant salt"));
        account = _create(initial, policy, _chains(), _initialProofs(initial, policy));
        handler = new V3SecurityHandler(account);
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

    function invariant_policyTransitionsPreserveCreationIdentityImplementationAndFunds() public view {
        handler.assertState();
        (uint32 generation, bytes32 id, bytes32 commitment, bytes32 salt) =
            AccountV3Initializable(address(account)).creationIdentity();
        assertEq(generation, 3);
        assertEq(id, initial.accountId);
        assertEq(commitment, initial.initialSecurityCommitment);
        assertEq(salt, initial.userSaltCommitment);
        assertEq(factory.getAddress(commitment, salt), address(account));
        assertEq(address(account).codehash, keccak256(type(AccountV3Proxy).runtimeCode));
        assertEq(AccountV3Proxy(payable(address(account))).proxyImplementation(), address(implementation));
        AccountV3SecurityModule moduleAccount = AccountV3SecurityModule(address(account));
        assertEq(moduleAccount.securityModule(), implementation.securityModule());
        assertEq(moduleAccount.securityModuleCodeHash(), moduleAccount.securityModule().codehash);
        assertEq(moduleAccount.securityModuleCodeHash(), factory.securityModuleCodeHash());
        assertEq(address(account).balance, 100 ether);
        assertEq(token.balanceOf(address(account)), 100 ether);
        assertEq(token.allowance(address(account), address(handler)), 0);
    }

    function invariant_creationLookupCannotResetSecurityOrNonces() public {
        bytes32 before_ = _fingerprint(account);
        assertEq(address(_create(initial, policy, new uint256[](0), new S.Signature[](0))), address(account));
        assertEq(_fingerprint(account), before_);
    }

    function test_realProxyHandlerExercisesRotationCancelExpiryAndFreeze() public {
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
        invariant_policyTransitionsPreserveCreationIdentityImplementationAndFunds();
        invariant_creationLookupCannotResetSecurityOrNonces();
    }
}
