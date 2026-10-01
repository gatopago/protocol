// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {DeploymentRoles} from "../script/DeploymentRoles.sol";

contract DeploymentRolesHarness {
    function validatePaymaster(uint256 chainId, address deployer, address owner, address signer) external pure {
        DeploymentRoles.validatePaymaster(chainId, deployer, owner, signer);
    }

    function validatePaymentRouter(uint256 chainId, address deployer, address owner, address treasury, address signer)
        external
        pure
    {
        DeploymentRoles.validatePaymentRouter(chainId, deployer, owner, treasury, signer);
    }

    function validatePaymentRouterV2(
        uint256 chainId,
        address deployer,
        address owner,
        address treasury,
        address signer,
        address pauseGuardian
    ) external pure {
        DeploymentRoles.validatePaymentRouterV2(chainId, deployer, owner, treasury, signer, pauseGuardian);
    }

    function validateCrosschainRouter(uint256 chainId, address deployer, address owner, address treasury)
        external
        pure
    {
        DeploymentRoles.validateCrosschainRouter(chainId, deployer, owner, treasury);
    }
}

contract DeploymentRolesTest is Test {
    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant AVALANCHE = 43114;
    uint256 internal constant AVALANCHE_FUJI = 43113;
    address internal constant FOUNDRY_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    address internal constant DEPLOYER = address(0xD1);
    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EE);
    address internal constant SIGNER = address(0x516E2);
    address internal constant PAUSE_GUARDIAN = address(0x600D);

    bytes32 internal constant ROLE_DEPLOYER = "deployer";
    bytes32 internal constant ROLE_OWNER = "owner";
    bytes32 internal constant ROLE_TREASURY = "treasury";
    bytes32 internal constant ROLE_PAYMASTER_SIGNER = "paymasterSigner";
    bytes32 internal constant ROLE_INVOICE_SIGNER = "invoiceSigner";
    bytes32 internal constant ROLE_AUTHORIZATION_SIGNER = "authorizationSigner";
    bytes32 internal constant ROLE_PAUSE_GUARDIAN = "pauseGuardian";

    DeploymentRolesHarness internal harness;

    function setUp() public {
        harness = new DeploymentRolesHarness();
    }

    function test_rejectsZeroAndFoundryDefaultBroadcastersOnEveryNetwork() public {
        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.UnsafeBroadcaster.selector, address(0)));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, address(0), address(0x1), address(0x2));

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.UnsafeBroadcaster.selector, FOUNDRY_SENDER));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, FOUNDRY_SENDER, address(0x1), address(0x2));
    }

    function test_rejectsMissingRolesOnEveryNetwork() public {
        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_OWNER));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, DEPLOYER, address(0), SIGNER);

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_TREASURY));
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, address(0), SIGNER);

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_INVOICE_SIGNER));
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, TREASURY, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_AUTHORIZATION_SIGNER)
        );
        harness.validatePaymentRouterV2(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, TREASURY, address(0), PAUSE_GUARDIAN);

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_PAUSE_GUARDIAN));
        harness.validatePaymentRouterV2(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, TREASURY, SIGNER, address(0));
    }

    function test_testnetAllowsIntentionalRoleReuse() public view {
        harness.validatePaymaster(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validatePaymentRouterV2(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER);

        harness.validatePaymaster(BASE_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validatePaymentRouterV2(BASE_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validateCrosschainRouter(AVALANCHE_FUJI, DEPLOYER, DEPLOYER, DEPLOYER);
    }

    function test_mainnetPaymasterAcceptsSeparatedRoles() public view {
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, SIGNER);
    }

    function test_mainnetPaymasterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, DEPLOYER, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_PAYMASTER_SIGNER, DEPLOYER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_PAYMASTER_SIGNER, OWNER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER);
    }

    function test_mainnetPaymentRouterAcceptsSeparatedRoles() public view {
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, SIGNER);
    }

    function test_mainnetPaymentRouterV2AcceptsSeparatedRolesOnAllProductionChains() public view {
        harness.validatePaymentRouterV2(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, SIGNER, PAUSE_GUARDIAN);
        harness.validatePaymentRouterV2(BASE, DEPLOYER, OWNER, TREASURY, SIGNER, PAUSE_GUARDIAN);
        harness.validatePaymentRouterV2(AVALANCHE, DEPLOYER, OWNER, TREASURY, SIGNER, PAUSE_GUARDIAN);
    }

    function test_mainnetPaymentRouterV2RejectsEveryRoleCollision() public {
        bytes32[5] memory roles =
            [ROLE_DEPLOYER, ROLE_OWNER, ROLE_TREASURY, ROLE_AUTHORIZATION_SIGNER, ROLE_PAUSE_GUARDIAN];
        address[5] memory baseline = [DEPLOYER, OWNER, TREASURY, SIGNER, PAUSE_GUARDIAN];

        for (uint256 i; i < baseline.length; ++i) {
            for (uint256 j = i + 1; j < baseline.length; ++j) {
                address[5] memory accounts = [DEPLOYER, OWNER, TREASURY, SIGNER, PAUSE_GUARDIAN];
                accounts[j] = accounts[i];
                _expectCollision(roles[i], roles[j], accounts[i]);
                harness.validatePaymentRouterV2(
                    ARBITRUM_ONE, accounts[0], accounts[1], accounts[2], accounts[3], accounts[4]
                );
            }
        }
    }

    function test_mainnetPaymentRouterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, DEPLOYER, TREASURY, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_TREASURY, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_INVOICE_SIGNER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_TREASURY, OWNER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER, SIGNER);

        _expectCollision(ROLE_OWNER, ROLE_INVOICE_SIGNER, OWNER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, OWNER);

        _expectCollision(ROLE_TREASURY, ROLE_INVOICE_SIGNER, TREASURY);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, TREASURY);
    }

    function test_mainnetCrosschainRouterAcceptsSeparatedRoles() public view {
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY);
    }

    function test_mainnetCrosschainRouterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, DEPLOYER, TREASURY);

        _expectCollision(ROLE_DEPLOYER, ROLE_TREASURY, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_TREASURY, OWNER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER);
    }

    function test_baseAndAvalancheMainnetDoNotBypassRoleSeparation() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validatePaymaster(BASE, DEPLOYER, DEPLOYER, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_TREASURY, DEPLOYER);
        harness.validateCrosschainRouter(AVALANCHE, DEPLOYER, OWNER, DEPLOYER);

        _expectCollision(ROLE_DEPLOYER, ROLE_AUTHORIZATION_SIGNER, DEPLOYER);
        harness.validatePaymentRouterV2(BASE, DEPLOYER, OWNER, TREASURY, DEPLOYER, PAUSE_GUARDIAN);
    }

    function _expectCollision(bytes32 firstRole, bytes32 secondRole, address account) internal {
        vm.expectRevert(
            abi.encodeWithSelector(DeploymentRoles.MainnetRoleCollision.selector, firstRole, secondRole, account)
        );
    }
}
