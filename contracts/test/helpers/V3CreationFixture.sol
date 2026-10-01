// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AccountFactoryV3} from "src/v3/AccountFactoryV3.sol";
import {AccountV3} from "src/v3/AccountV3.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Storage as D} from "src/v3/AccountV3Storage.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";
import {AccountV3Security as Security} from "src/v3/AccountV3Security.sol";
import {AccountV3Validity as Validity} from "src/v3/AccountV3Validity.sol";
import {AccountV3Initialization as Initialization} from "src/v3/AccountV3Initialization.sol";
import {V3SecurityFixture, V3SecurityHarness} from "test/helpers/V3SecurityFixture.sol";

/// @dev Call-path fixture ONLY: no UserOperation validation, gas accounting or bundler simulation.
contract V3CreationSender {
    address private immutable _entryPoint;

    constructor() {
        _entryPoint = msg.sender;
    }

    function forward(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == _entryPoint, "fixture: EntryPoint only");
        return Address.functionCall(target, data);
    }
}

contract V3CreationEntryPoint {
    V3CreationSender public immutable senderCreator = new V3CreationSender();

    function forward(address target, bytes calldata data) external returns (bytes memory) {
        bytes memory result = senderCreator.forward(target, data);
        // Fixture-only approximation of the post-creation validation phase. The separate real
        // EntryPoint suite proves handleOps validation, prefund, nonce, timing and rollback.
        V3InitializedSecurityHarness(payable(abi.decode(result, (address)))).fixtureValidateCreation();
        return result;
    }
}

/// @dev Test composition with REAL authenticated initialization and REAL security transitions.
/// Full Account V3 with observation views and a fixture-only validation entrypoint for isolated
/// creation tests. Real EntryPoint/execution tests never call fixtureValidateCreation.
contract V3InitializedSecurityHarness is AccountV3 {
    constructor(address ep) AccountV3(ep) {}

    function fixtureValidateCreation() external {
        require(msg.sender == initializationEntryPoint(), "fixture: EntryPoint only");
        uint256 data = Validity.creationData();
        if (data == 0) return;
        // Fixture-only decoding of the timestamp fields. The real EntryPoint test suite owns
        // validationData intersection and temporal boundary proof; do not inline its full runtime
        // into this security-only composition when measuring remaining implementation headroom.
        // Isolate each 48-bit field explicitly; until must not include the upper after field.
        uint48 after_ = SafeCast.toUint48(data >> 208);
        uint48 until_ = SafeCast.toUint48((data >> 160) & type(uint48).max);
        // Synthetic clock selects a test validity boundary, not randomness or production finality.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= after_ || block.timestamp > until_) {
            revert Initialization.AccountV3Initialization__OutsideValidity();
        }
        delete D.layout().creationValidAfter;
        delete D.layout().creationValidUntil;
    }

    function spendEnabled() external view {
        Security.requireSpendEnabled();
    }

    function snapshot() external view returns (V3SecurityHarness.Snapshot memory) {
        D.Layout storage s = D.layout();
        return V3SecurityHarness.Snapshot(
            s.upgradesFrozen,
            s.securityVersion,
            D.accountId(s),
            s.manifestHash,
            s.chainScopeHash,
            s.adminNonce,
            s.spendNonce,
            securityPolicy(),
            s.pending
        );
    }
}

abstract contract V3CreationFixture is V3SecurityFixture {
    V3CreationEntryPoint internal ep;
    V3InitializedSecurityHarness internal implementation;
    AccountFactoryV3 internal factory;

    function _setupCreation() internal {
        _setupKeys();
        ep = new V3CreationEntryPoint();
        implementation = new V3InitializedSecurityHarness(address(ep));
        factory = new AccountFactoryV3(address(implementation), address(ep));
    }

    function _initial(T.SecurityPolicy memory policy, bytes32 salt)
        internal
        view
        returns (T.InitializationApproval memory m)
    {
        bytes32 commitment = T.hashPolicy(policy);
        m = T.InitializationApproval(
            T.accountId(commitment, salt),
            3,
            commitment,
            salt,
            address(factory),
            address(ep),
            keccak256(abi.encode(_chains())),
            0,
            SafeCast.toUint48(block.timestamp),
            SafeCast.toUint48(block.timestamp + 1 days)
        );
    }

    function _initialProofs(T.InitializationApproval memory m, T.SecurityPolicy memory policy)
        internal
        view
        returns (S.Signature[] memory proofs)
    {
        address predicted = factory.getAddress(m.initialSecurityCommitment, m.userSaltCommitment);
        bytes32 digest = T.digest(block.chainid, predicted, T.hashInitialization(m));
        proofs = new S.Signature[](policy.signers.length);
        for (uint256 i; i < proofs.length; ++i) {
            proofs[i] = S.Signature(SafeCast.toUint8(i), _memberSign(policy.signers[i], digest));
        }
    }

    function _create(
        T.InitializationApproval memory m,
        T.SecurityPolicy memory policy,
        uint256[] memory chains,
        S.Signature[] memory proofs
    ) internal returns (V3SecurityHarness account) {
        bytes memory result = ep.forward(
            address(factory), abi.encodeCall(factory.createAccount, (m, policy, chains, proofs))
        );
        account = V3SecurityHarness(abi.decode(result, (address)));
    }
}
