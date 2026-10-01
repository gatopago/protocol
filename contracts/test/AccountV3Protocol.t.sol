// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AccountV3Types as T} from "src/v3/AccountV3Types.sol";
import {AccountV3Policy as Policy} from "src/v3/AccountV3Policy.sol";
import {AccountV3Signatures as S} from "src/v3/AccountV3Signatures.sol";

contract AccountV3ProtocolTest is Test {
    using stdJson for string;
    string internal vectors;

    function setUp() public {
        vectors = vm.readFile("test/fixtures/v3-protocol.json");
    }

    function test_identityAndCreate2Vector() public view {
        bytes32 id = T.accountId(
            vectors.readBytes32(".identity.initialSecurityCommitment"),
            vectors.readBytes32(".identity.userSaltCommitment")
        );
        assertEq(id, vectors.readBytes32(".identity.accountId"));
        assertEq(T.IDENTITY_TYPEHASH, vectors.readBytes32(".identity.expectedTypeHash"));
        bytes32 predicted = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                vectors.readAddress(".identity.factory"),
                id,
                vectors.readBytes32(".identity.proxyInitCodeHash")
            )
        );
        assertEq(address(uint160(uint256(predicted))), vectors.readAddress(".identity.accountAddress"));
    }

    function test_accountSignatureHashAndEnvelopeVector() public view {
        T.AccountSignature memory message = T.AccountSignature(
            vectors.readBytes32(".contractSignature.message.accountId"),
            3,
            1,
            vectors.readBytes32(".contractSignature.message.applicationHash")
        );
        assertEq(T.ACCOUNT_SIGNATURE_TYPEHASH, vectors.readBytes32(".contractSignature.expectedTypeHash"));
        bytes32 structHash = T.hashAccountSignature(message);
        assertEq(structHash, vectors.readBytes32(".contractSignature.expectedStructHash"));
        assertEq(
            T.digest(84532, vectors.readAddress(".identity.accountAddress"), structHash),
            vectors.readBytes32(".contractSignature.expectedDigest")
        );
        S.Signature[] memory votes = new S.Signature[](1);
        votes[0] = S.Signature(0, hex"1234");
        assertEq(abi.encode(message, votes), vectors.readBytes(".contractSignature.envelope"));
    }

    function test_initialAndActivePolicyVector() public view {
        T.SecurityPolicy memory initial = _policy(".initialPolicy", 1, 1);
        T.SecurityPolicy memory active = _policy(".activePolicy", 2, 1);
        Policy.validate(initial);
        Policy.validate(active);
        assertEq(T.hashPolicy(initial), vectors.readBytes32(".identity.initialSecurityCommitment"));
        assertEq(T.hashPolicy(active), vectors.readBytes32(".activePolicyHash"));
        assertNotEq(T.hashPolicy(initial), T.hashPolicy(active));
    }

    function test_scopeAndCallsEncodingVector() public view {
        uint256[] memory chains = new uint256[](3);
        chains[0] = 43113;
        chains[1] = 84532;
        chains[2] = 421614;
        assertEq(keccak256(abi.encode(chains)), vectors.readBytes32(".chainScopeHash"));
        T.Call[] memory calls = new T.Call[](2);
        calls[0] = T.Call(
            vectors.readAddress(".calls[0].target"),
            vectors.readUint(".calls[0].value"),
            vectors.readBytes(".calls[0].data")
        );
        calls[1] = T.Call(
            vectors.readAddress(".calls[1].target"),
            vectors.readUint(".calls[1].value"),
            vectors.readBytes(".calls[1].data")
        );
        assertEq(keccak256(abi.encode(calls)), vectors.readBytes32(".callsHash"));
    }

    function test_executionVector() public view {
        string memory p = ".authorizations.ExecutionPlan.message.";
        T.ExecutionPlan memory plan = T.ExecutionPlan({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            executionMode: uint8(vectors.readUint(string.concat(p, "executionMode"))),
            entryPoint: vectors.readAddress(string.concat(p, "entryPoint")),
            userOpHash: vectors.readBytes32(string.concat(p, "userOpHash")),
            callsHash: vectors.readBytes32(string.concat(p, "callsHash")),
            assetLimitsHash: vectors.readBytes32(string.concat(p, "assetLimitsHash")),
            feePolicyHash: vectors.readBytes32(string.concat(p, "feePolicyHash")),
            paymaster: vectors.readAddress(string.concat(p, "paymaster")),
            previewHash: vectors.readBytes32(string.concat(p, "previewHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("ExecutionPlan", T.EXECUTION_TYPEHASH, T.hashExecution(plan));
    }

    function test_securityVector() public view {
        _check("SecurityChange", T.SECURITY_TYPEHASH, T.hashSecurity(_change()));
        assertEq(T.MIN_UPGRADE_DELAY, 72 hours);
    }

    function test_upgradeVector() public view {
        string memory p = ".authorizations.UpgradeManifest.message.";
        T.UpgradeManifest memory manifest = T.UpgradeManifest({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            previousManifestHash: vectors.readBytes32(string.concat(p, "previousManifestHash")),
            implementation: vectors.readAddress(string.concat(p, "implementation")),
            runtimeCodeHash: vectors.readBytes32(string.concat(p, "runtimeCodeHash")),
            storageLayoutHash: vectors.readBytes32(string.concat(p, "storageLayoutHash")),
            chainScopeHash: vectors.readBytes32(string.concat(p, "chainScopeHash")),
            migrationCallHash: vectors.readBytes32(string.concat(p, "migrationCallHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("UpgradeManifest", T.UPGRADE_TYPEHASH, T.hashUpgrade(manifest));
    }

    function test_initializationApprovalVector() public view {
        string memory p = ".authorizations.InitializationApproval.message.";
        T.InitializationApproval memory approval = T.InitializationApproval({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            initialSecurityCommitment: vectors.readBytes32(string.concat(p, "initialSecurityCommitment")),
            userSaltCommitment: vectors.readBytes32(string.concat(p, "userSaltCommitment")),
            factory: vectors.readAddress(string.concat(p, "factory")),
            entryPoint: vectors.readAddress(string.concat(p, "entryPoint")),
            chainScopeHash: vectors.readBytes32(string.concat(p, "chainScopeHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("InitializationApproval", T.INITIALIZATION_TYPEHASH, T.hashInitialization(approval));
        assertEq(approval.accountId, T.accountId(approval.initialSecurityCommitment, approval.userSaltCommitment));
    }

    function test_enrollmentProofVector() public view {
        string memory p = ".authorizations.EnrollmentProof.message.";
        T.EnrollmentProof memory proof = T.EnrollmentProof({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            signerId: vectors.readBytes32(string.concat(p, "signerId")),
            nextPolicyHash: vectors.readBytes32(string.concat(p, "nextPolicyHash")),
            contextHash: vectors.readBytes32(string.concat(p, "contextHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("EnrollmentProof", T.ENROLLMENT_TYPEHASH, T.hashEnrollment(proof));
    }

    function test_cancelProofVector() public view {
        string memory p = ".authorizations.CancelProposal.message.";
        T.CancelProposal memory cancel = T.CancelProposal({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            proposalHash: vectors.readBytes32(string.concat(p, "proposalHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("CancelProposal", T.CANCEL_TYPEHASH, T.hashCancel(cancel));
    }

    function test_freezeProofVector() public view {
        string memory p = ".authorizations.FreezeUpgrades.message.";
        T.FreezeUpgrades memory freeze = T.FreezeUpgrades({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            previousManifestHash: vectors.readBytes32(string.concat(p, "previousManifestHash")),
            chainScopeHash: vectors.readBytes32(string.concat(p, "chainScopeHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("FreezeUpgrades", T.FREEZE_TYPEHASH, T.hashFreeze(freeze));
    }

    function test_commitProofVector() public view {
        string memory p = ".authorizations.CommitProposal.message.";
        T.CommitProposal memory commit = T.CommitProposal({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            previousManifestHash: vectors.readBytes32(string.concat(p, "previousManifestHash")),
            proposalHash: vectors.readBytes32(string.concat(p, "proposalHash")),
            acknowledgementsHash: vectors.readBytes32(string.concat(p, "acknowledgementsHash")),
            chainScopeHash: vectors.readBytes32(string.concat(p, "chainScopeHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil")))
        });
        _check("CommitProposal", T.COMMIT_TYPEHASH, T.hashCommit(commit));
    }

    function test_chainNeutralSecurityManifestVector() public view {
        T.SecurityManifest memory manifest = T.SecurityManifest({
            accountId: vectors.readBytes32(".securityManifest.accountId"),
            generation: uint32(vectors.readUint(".securityManifest.generation")),
            securityVersion: uint64(vectors.readUint(".securityManifest.securityVersion")),
            previousManifestHash: vectors.readBytes32(".securityManifest.previousManifestHash"),
            policyHash: vectors.readBytes32(".securityManifest.policyHash"),
            chainScopeHash: vectors.readBytes32(".securityManifest.chainScopeHash")
        });
        assertEq(T.hashManifest(manifest), vectors.readBytes32(".securityManifestHash"));
        manifest.securityVersion++;
        assertNotEq(T.hashManifest(manifest), vectors.readBytes32(".securityManifestHash"));
    }

    function testFuzz_chainDomainIsNotPortable(uint256 otherChain) public view {
        vm.assume(otherChain != 84532);
        bytes32 structure = T.hashSecurity(_change());
        address account = vectors.readAddress(".identity.accountAddress");
        assertNotEq(T.digest(84532, account, structure), T.digest(otherChain, account, structure));
    }

    function testFuzz_saltBindsAccount(bytes32 otherSalt) public view {
        bytes32 initial = vectors.readBytes32(".identity.initialSecurityCommitment");
        vm.assume(otherSalt != vectors.readBytes32(".identity.userSaltCommitment"));
        assertNotEq(T.accountId(initial, otherSalt), vectors.readBytes32(".identity.accountId"));
    }

    function _check(string memory kind, bytes32 typeHash, bytes32 structHash) internal view {
        string memory p = string.concat(".authorizations.", kind, ".");
        assertEq(typeHash, vectors.readBytes32(string.concat(p, "expectedTypeHash")));
        assertEq(structHash, vectors.readBytes32(string.concat(p, "expectedStructHash")));
        assertEq(
            T.digest(
                vectors.readUint(string.concat(p, "domain.chainId")),
                vectors.readAddress(string.concat(p, "domain.verifyingContract")),
                structHash
            ),
            vectors.readBytes32(string.concat(p, "expectedDigest"))
        );
    }

    function _change() internal view returns (T.SecurityChange memory) {
        string memory p = ".authorizations.SecurityChange.message.";
        return T.SecurityChange({
            accountId: vectors.readBytes32(string.concat(p, "accountId")),
            generation: uint32(vectors.readUint(string.concat(p, "generation"))),
            securityVersion: uint64(vectors.readUint(string.concat(p, "securityVersion"))),
            previousManifestHash: vectors.readBytes32(string.concat(p, "previousManifestHash")),
            nextPolicyHash: vectors.readBytes32(string.concat(p, "nextPolicyHash")),
            chainScopeHash: vectors.readBytes32(string.concat(p, "chainScopeHash")),
            nonce: vectors.readUint(string.concat(p, "nonce")),
            validAfter: uint48(vectors.readUint(string.concat(p, "validAfter"))),
            validUntil: uint48(vectors.readUint(string.concat(p, "validUntil"))),
            proposalValidUntil: uint48(vectors.readUint(string.concat(p, "proposalValidUntil")))
        });
    }

    function _policy(string memory path, uint256 length, uint8 mode)
        internal
        view
        returns (T.SecurityPolicy memory policy)
    {
        policy.mode = mode;
        policy.signers = new T.SignerDescriptor[](length);
        for (uint256 i; i < length; i++) {
            string memory p = string.concat(path, ".signers[", vm.toString(i), "].");
            policy.signers[i] = T.SignerDescriptor({
                kind: uint8(vectors.readUint(string.concat(p, "kind"))),
                verifier: vectors.readAddress(string.concat(p, "verifier")),
                verifierCodeHash: vectors.readBytes32(string.concat(p, "verifierCodeHash")),
                key: vectors.readBytes(string.concat(p, "key")),
                roles: uint8(vectors.readUint(string.concat(p, "roles")))
            });
        }
        policy.spendThreshold = uint16(vectors.readUint(string.concat(path, ".spendThreshold")));
        policy.adminThreshold = uint16(vectors.readUint(string.concat(path, ".adminThreshold")));
        policy.upgradeDelaySeconds = uint48(vectors.readUint(string.concat(path, ".upgradeDelaySeconds")));
    }
}
