// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";

contract NetworkDeploymentConfigHarness {
    function get(uint256 chainId) external pure returns (NetworkDeploymentConfig.Config memory config) {
        config = NetworkDeploymentConfig.get(chainId);
    }

    function outboundDomains(uint256 chainId) external pure returns (uint32[] memory domains) {
        domains = NetworkDeploymentConfig.outboundDomains(NetworkDeploymentConfig.get(chainId));
    }

    function requireInboundSourceChain(uint256 chainId) external pure {
        NetworkDeploymentConfig.requireInboundSourceChain(NetworkDeploymentConfig.get(chainId));
    }

    function requireCrosschainRouterChain(uint256 chainId) external pure {
        NetworkDeploymentConfig.requireCrosschainRouterChain(NetworkDeploymentConfig.get(chainId));
    }
}

contract NetworkDeploymentConfigTest is Test {
    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant AVALANCHE = 43114;
    uint256 internal constant AVALANCHE_FUJI = 43113;

    NetworkDeploymentConfigHarness internal harness;

    function setUp() public {
        harness = new NetworkDeploymentConfigHarness();
    }

    function test_configuresArbitrumAsOnlyHomeChain() public view {
        NetworkDeploymentConfig.Config memory arbitrumTestnet = harness.get(ARBITRUM_SEPOLIA);
        NetworkDeploymentConfig.Config memory arbitrumMainnet = harness.get(ARBITRUM_ONE);
        assertTrue(arbitrumTestnet.isHomeChain);
        assertTrue(arbitrumMainnet.isHomeChain);
        assertEq(arbitrumTestnet.settlementChainId, ARBITRUM_SEPOLIA);
        assertEq(arbitrumMainnet.settlementChainId, ARBITRUM_ONE);
        assertGt(arbitrumTestnet.paymasterStake, 0);
        assertGt(arbitrumMainnet.paymasterDeposit, 0);
    }

    function test_configuresBaseAndAvalancheAsInboundOnly() public view {
        NetworkDeploymentConfig.Config memory baseTestnet = harness.get(BASE_SEPOLIA);
        NetworkDeploymentConfig.Config memory baseMainnet = harness.get(BASE);
        NetworkDeploymentConfig.Config memory avalancheTestnet = harness.get(AVALANCHE_FUJI);
        NetworkDeploymentConfig.Config memory avalancheMainnet = harness.get(AVALANCHE);

        assertFalse(baseTestnet.isHomeChain);
        assertFalse(baseMainnet.isHomeChain);
        assertFalse(avalancheTestnet.isHomeChain);
        assertFalse(avalancheMainnet.isHomeChain);
        assertEq(baseTestnet.settlementChainId, ARBITRUM_SEPOLIA);
        assertEq(avalancheTestnet.settlementChainId, ARBITRUM_SEPOLIA);
        assertEq(baseMainnet.settlementChainId, ARBITRUM_ONE);
        assertEq(avalancheMainnet.settlementChainId, ARBITRUM_ONE);
        assertEq(baseTestnet.paymasterStake, 0);
        assertEq(avalancheMainnet.paymasterDeposit, 0);
        assertEq(baseTestnet.cctpPaymentPlatformFeeCapBps, 100);
        assertEq(avalancheTestnet.cctpPaymentPlatformFeeCapBps, 100);
        assertEq(baseMainnet.cctpPaymentPlatformFeeCapBps, 100);
        assertEq(avalancheMainnet.cctpPaymentPlatformFeeCapBps, 100);
    }

    function test_fastCapabilityMatchesCircleSupport() public view {
        assertTrue(harness.get(ARBITRUM_SEPOLIA).cctpFastSupported);
        assertTrue(harness.get(ARBITRUM_ONE).cctpFastSupported);
        assertTrue(harness.get(BASE_SEPOLIA).cctpFastSupported);
        assertTrue(harness.get(BASE).cctpFastSupported);
        assertFalse(harness.get(AVALANCHE_FUJI).cctpFastSupported);
        assertFalse(harness.get(AVALANCHE).cctpFastSupported);
    }

    function test_cctpDomainsAreFrozenForThreeChains() public view {
        assertEq(harness.get(ARBITRUM_SEPOLIA).cctpDomain, 3);
        assertEq(harness.get(BASE_SEPOLIA).cctpDomain, 6);
        assertEq(harness.get(AVALANCHE_FUJI).cctpDomain, 1);
        assertEq(harness.get(ARBITRUM_ONE).cctpDomain, 3);
        assertEq(harness.get(BASE).cctpDomain, 6);
        assertEq(harness.get(AVALANCHE).cctpDomain, 1);
    }

    function test_outboundHomeDomainsAreAvalancheAndBase() public view {
        uint32[] memory testnetDomains = harness.outboundDomains(ARBITRUM_SEPOLIA);
        uint32[] memory mainnetDomains = harness.outboundDomains(ARBITRUM_ONE);
        assertEq(testnetDomains.length, 2);
        assertEq(testnetDomains[0], 1);
        assertEq(testnetDomains[1], 6);
        assertEq(mainnetDomains[0], 1);
        assertEq(mainnetDomains[1], 6);
    }

    function test_fujiWalletRailRoutesBackToArbitrumTestnet() public view {
        uint32[] memory domains = harness.outboundDomains(AVALANCHE_FUJI);
        assertEq(domains.length, 1);
        assertEq(domains[0], 3);
        harness.requireCrosschainRouterChain(AVALANCHE_FUJI);
    }

    function test_mainnetSatelliteCrosschainRouterNeedsSeparateRelease() public {
        vm.expectRevert(
            abi.encodeWithSelector(NetworkDeploymentConfig.NetworkDeploymentConfig__NotHomeChain.selector, AVALANCHE)
        );
        harness.requireCrosschainRouterChain(AVALANCHE);
    }

    function test_rejectsWrongDeploymentRoleForChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(NetworkDeploymentConfig.NetworkDeploymentConfig__NotHomeChain.selector, BASE)
        );
        harness.outboundDomains(BASE);

        vm.expectRevert(
            abi.encodeWithSelector(
                NetworkDeploymentConfig.NetworkDeploymentConfig__HomeChainCannotUseInboundRouter.selector, ARBITRUM_ONE
            )
        );
        harness.requireInboundSourceChain(ARBITRUM_ONE);
    }

    function test_rejectsUnknownChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(NetworkDeploymentConfig.NetworkDeploymentConfig__UnsupportedChain.selector, 31337)
        );
        harness.get(31337);
    }
}
