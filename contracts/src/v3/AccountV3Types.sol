// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice E0 protocol encoding only. This library grants no authority and deploys no account.
/// @dev Names, order and widths are shared with shared/v3/authorizations.ts and golden vectors.
library AccountV3Types {
    uint32 internal constant GENERATION = 3;
    uint48 internal constant MIN_UPGRADE_DELAY = 72 hours;
    uint48 internal constant MAX_CONSENT_WINDOW = 5 minutes;
    uint48 internal constant MAX_PROPOSAL_COMPLETION = 7 days;

    bytes32 internal constant IDENTITY_TYPEHASH =
        keccak256("AccountIdentity(uint32 generation,bytes32 initialSecurityCommitment,bytes32 userSaltCommitment)");
    bytes32 internal constant INITIALIZATION_TYPEHASH = keccak256(
        "InitializationApproval(bytes32 accountId,uint32 generation,bytes32 initialSecurityCommitment,bytes32 userSaltCommitment,address factory,address entryPoint,bytes32 chainScopeHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant ENROLLMENT_TYPEHASH = keccak256(
        "EnrollmentProof(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 signerId,bytes32 nextPolicyHash,bytes32 contextHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256(
        "CancelProposal(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 proposalHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant FREEZE_TYPEHASH = keccak256(
        "FreezeUpgrades(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,bytes32 chainScopeHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant COMMIT_TYPEHASH = keccak256(
        "CommitProposal(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,bytes32 proposalHash,bytes32 acknowledgementsHash,bytes32 chainScopeHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant MANIFEST_TYPEHASH = keccak256(
        "SecurityManifest(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,bytes32 policyHash,bytes32 chainScopeHash)"
    );
    bytes32 internal constant EXECUTION_TYPEHASH = keccak256(
        "ExecutionPlan(bytes32 accountId,uint32 generation,uint64 securityVersion,uint8 executionMode,address entryPoint,bytes32 userOpHash,bytes32 callsHash,bytes32 assetLimitsHash,bytes32 feePolicyHash,address paymaster,bytes32 previewHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant SECURITY_TYPEHASH = keccak256(
        "SecurityChange(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,bytes32 nextPolicyHash,bytes32 chainScopeHash,uint256 nonce,uint48 validAfter,uint48 validUntil,uint48 proposalValidUntil)"
    );
    bytes32 internal constant UPGRADE_TYPEHASH = keccak256(
        "UpgradeManifest(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 previousManifestHash,address implementation,bytes32 runtimeCodeHash,bytes32 storageLayoutHash,bytes32 chainScopeHash,bytes32 migrationCallHash,uint256 nonce,uint48 validAfter,uint48 validUntil)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string internal constant DOMAIN_NAME = "GatoPago Account";
    string internal constant DOMAIN_VERSION = "3.0-consumer";
    bytes32 internal constant ACCOUNT_SIGNATURE_TYPEHASH = keccak256(
        "AccountSignature(bytes32 accountId,uint32 generation,uint64 securityVersion,bytes32 applicationHash)"
    );

    bytes32 internal constant SIGNER_TYPEHASH =
        keccak256("SignerDescriptor(uint8 kind,address verifier,bytes32 verifierCodeHash,bytes32 keyHash)");
    bytes32 internal constant MEMBER_TYPEHASH = keccak256("SignerMember(bytes32 signerId,uint8 roles)");
    bytes32 internal constant POLICY_TYPEHASH = keccak256(
        "SecurityPolicy(uint8 mode,bytes32 membersHash,uint16 spendThreshold,uint16 adminThreshold,uint48 upgradeDelaySeconds)"
    );

    struct SignerDescriptor {
        uint8 kind;
        address verifier;
        bytes32 verifierCodeHash;
        bytes key;
        uint8 roles;
    }

    struct SecurityPolicy {
        uint8 mode;
        SignerDescriptor[] signers;
        uint16 spendThreshold;
        uint16 adminThreshold;
        uint48 upgradeDelaySeconds;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev ERC-1271 approval, NOT an ExecutionPlan. Consumer owns domain, expiry and replay protection.
    struct AccountSignature {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 applicationHash;
    }

    /// @dev Signed separately BEFORE initCode/UserOp construction, avoiding a signature/hash cycle.
    struct InitializationApproval {
        bytes32 accountId;
        uint32 generation;
        bytes32 initialSecurityCommitment;
        bytes32 userSaltCommitment;
        address factory;
        address entryPoint;
        bytes32 chainScopeHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    struct EnrollmentProof {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 signerId;
        bytes32 nextPolicyHash;
        bytes32 contextHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    struct CancelProposal {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 proposalHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    struct FreezeUpgrades {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 previousManifestHash;
        bytes32 chainScopeHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    struct CommitProposal {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 previousManifestHash;
        bytes32 proposalHash;
        bytes32 acknowledgementsHash;
        bytes32 chainScopeHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    /// @dev Same policy hash on each chain; signatures/nonces/receipts remain chain-local evidence.
    struct SecurityManifest {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 previousManifestHash;
        bytes32 policyHash;
        bytes32 chainScopeHash;
    }

    struct ExecutionPlan {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        uint8 executionMode;
        address entryPoint;
        bytes32 userOpHash;
        bytes32 callsHash;
        bytes32 assetLimitsHash;
        bytes32 feePolicyHash;
        address paymaster;
        bytes32 previewHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    /// @dev Administrative policy change; no recovery or bootstrap authority exists.
    struct SecurityChange {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 previousManifestHash;
        bytes32 nextPolicyHash;
        bytes32 chainScopeHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
        // Separately signed lifetime of an accepted proposal, not permission to submit late.
        uint48 proposalValidUntil;
    }

    struct UpgradeManifest {
        bytes32 accountId;
        uint32 generation;
        uint64 securityVersion;
        bytes32 previousManifestHash;
        address implementation;
        bytes32 runtimeCodeHash;
        bytes32 storageLayoutHash;
        bytes32 chainScopeHash;
        bytes32 migrationCallHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 validUntil;
    }

    function accountId(bytes32 initialSecurityCommitment, bytes32 userSaltCommitment) internal pure returns (bytes32) {
        return keccak256(abi.encode(IDENTITY_TYPEHASH, GENERATION, initialSecurityCommitment, userSaltCommitment));
    }

    function signerId(SignerDescriptor memory signer) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(SIGNER_TYPEHASH, signer.kind, signer.verifier, signer.verifierCodeHash, keccak256(signer.key))
        );
    }

    /// @dev Pure encoding; policy validation and signatures are not implied by a hash.
    function hashPolicy(SecurityPolicy memory policy) internal pure returns (bytes32) {
        bytes32[] memory members = new bytes32[](policy.signers.length);
        for (uint256 i; i < members.length; i++) {
            members[i] = keccak256(abi.encode(MEMBER_TYPEHASH, signerId(policy.signers[i]), policy.signers[i].roles));
        }
        return keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                policy.mode,
                keccak256(abi.encode(members)),
                policy.spendThreshold,
                policy.adminThreshold,
                policy.upgradeDelaySeconds
            )
        );
    }

    function hashExecution(ExecutionPlan memory plan) internal pure returns (bytes32) {
        return keccak256(abi.encode(EXECUTION_TYPEHASH, plan));
    }

    function hashAccountSignature(AccountSignature memory message) internal pure returns (bytes32) {
        return keccak256(abi.encode(ACCOUNT_SIGNATURE_TYPEHASH, message));
    }

    function hashInitialization(InitializationApproval memory approval) internal pure returns (bytes32) {
        return keccak256(abi.encode(INITIALIZATION_TYPEHASH, approval));
    }

    function hashEnrollment(EnrollmentProof memory proof) internal pure returns (bytes32) {
        return keccak256(abi.encode(ENROLLMENT_TYPEHASH, proof));
    }

    function hashCancel(CancelProposal memory message) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCEL_TYPEHASH, message));
    }

    function hashFreeze(FreezeUpgrades memory freeze) internal pure returns (bytes32) {
        return keccak256(abi.encode(FREEZE_TYPEHASH, freeze));
    }

    function hashCommit(CommitProposal memory commit) internal pure returns (bytes32) {
        return keccak256(abi.encode(COMMIT_TYPEHASH, commit));
    }

    function hashManifest(SecurityManifest memory manifest) internal pure returns (bytes32) {
        return keccak256(abi.encode(MANIFEST_TYPEHASH, manifest));
    }

    function hashSecurity(SecurityChange memory change) internal pure returns (bytes32) {
        return keccak256(abi.encode(SECURITY_TYPEHASH, change));
    }

    function hashUpgrade(UpgradeManifest memory manifest) internal pure returns (bytes32) {
        return keccak256(abi.encode(UPGRADE_TYPEHASH, manifest));
    }

    function digest(uint256 chainId, address account, bytes32 structHash) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes(DOMAIN_NAME)), keccak256(bytes(DOMAIN_VERSION)), chainId, account
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }
}
