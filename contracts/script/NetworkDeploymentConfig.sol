// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Frozen deployment facts and safety preflights for GatoPago's first
///         three production chains and their testnets.
library NetworkDeploymentConfig {
    address internal constant ENTRY_POINT_V09 = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant TESTNET_TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant MAINNET_TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;

    bytes32 internal constant TOKEN_MESSENGER_CODEHASH =
        0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99;
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant AVALANCHE = 43114;
    uint256 internal constant AVALANCHE_FUJI = 43113;

    uint32 internal constant AVALANCHE_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 3;
    uint32 internal constant BASE_DOMAIN = 6;

    struct Config {
        uint256 chainId;
        uint256 settlementChainId;
        uint32 cctpDomain;
        bool isTestnet;
        bool isHomeChain;
        bool cctpFastSupported;
        uint16 cctpPaymentPlatformFeeCapBps;
        address entryPoint;
        address usdc;
        address tokenMessenger;
        bytes32 entryPointCodehash;
        bytes32 usdcCodehash;
        bytes32 tokenMessengerCodehash;
        bytes32 create2DeployerCodehash;
        uint256 paymasterStake;
        uint32 paymasterUnstakeDelay;
        uint256 paymasterDeposit;
        uint256 maxSponsoredGasCost;
    }

    error NetworkDeploymentConfig__UnsupportedChain(uint256 chainId);
    error NetworkDeploymentConfig__CodehashMismatch(
        bytes32 component, address target, bytes32 expected, bytes32 actual
    );
    error NetworkDeploymentConfig__NotHomeChain(uint256 chainId);
    error NetworkDeploymentConfig__HomeChainCannotUseInboundRouter(uint256 chainId);

    function get(uint256 chainId) internal pure returns (Config memory config) {
        if (chainId == ARBITRUM_SEPOLIA) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_SEPOLIA,
                cctpDomain: ARBITRUM_DOMAIN,
                isTestnet: true,
                isHomeChain: true,
                cctpFastSupported: true,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d,
                tokenMessenger: TESTNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x66104e61203e3b9cf29303ececd9367b6329f6caa2bb063361ea75b7b92a7678,
                usdcCodehash: 0x9a736af6aac290d9196883e8686fc1d127ff657ca534fe4b88d6d40dc0bc6750,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                paymasterStake: 0.001 ether,
                paymasterUnstakeDelay: 1 days,
                paymasterDeposit: 0.01 ether,
                maxSponsoredGasCost: 0.005 ether
            });
        }
        if (chainId == BASE_SEPOLIA) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_SEPOLIA,
                cctpDomain: BASE_DOMAIN,
                isTestnet: true,
                isHomeChain: false,
                cctpFastSupported: true,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0x036CbD53842c5426634e7929541eC2318f3dCF7e,
                tokenMessenger: TESTNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x216eed2b302d9cb687852c673dfaa962b4c85e2a790f19aa4b61608ea1fee04d,
                usdcCodehash: 0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                paymasterStake: 0,
                paymasterUnstakeDelay: 0,
                paymasterDeposit: 0,
                maxSponsoredGasCost: 0
            });
        }
        if (chainId == AVALANCHE_FUJI) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_SEPOLIA,
                cctpDomain: AVALANCHE_DOMAIN,
                isTestnet: true,
                isHomeChain: false,
                cctpFastSupported: false,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0x5425890298aed601595a70AB815c96711a31Bc65,
                tokenMessenger: TESTNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x0fccc3a33a211cab9f742b15d374ca1144d8fb814fa6d2244465b9d667583412,
                usdcCodehash: 0x7140a935aa3bb55d334d6d325fea277e47674770b10823feefa6f8b2c58af5fc,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                // Phase 4A wallet rail. These are deliberately modest testnet
                // limits; deploying the paymaster still requires the explicit
                // GATOPAGO_DEPLOY_PAYMASTER=true opt-in in DeployV2.
                paymasterStake: 0.001 ether,
                paymasterUnstakeDelay: 1 days,
                paymasterDeposit: 0.05 ether,
                maxSponsoredGasCost: 0.01 ether
            });
        }
        if (chainId == ARBITRUM_ONE) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_ONE,
                cctpDomain: ARBITRUM_DOMAIN,
                isTestnet: false,
                isHomeChain: true,
                cctpFastSupported: true,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
                tokenMessenger: MAINNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x366bdda453c3f5701b236ddf48347220c1ea6404a7f01861d79a30d25bb6eb74,
                usdcCodehash: 0xad30d819dbc47814b7e6cb837fd7cc57fcb591479a38596ee93de4fc52e8c435,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                paymasterStake: 0.001 ether,
                paymasterUnstakeDelay: 1 days,
                paymasterDeposit: 0.01 ether,
                maxSponsoredGasCost: 0.005 ether
            });
        }
        if (chainId == BASE) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_ONE,
                cctpDomain: BASE_DOMAIN,
                isTestnet: false,
                isHomeChain: false,
                cctpFastSupported: true,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
                tokenMessenger: MAINNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x826b7ec542db9f3345234a25c2a6330a61f99483dedb6e6709928cc97e4e4d5d,
                usdcCodehash: 0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                paymasterStake: 0,
                paymasterUnstakeDelay: 0,
                paymasterDeposit: 0,
                maxSponsoredGasCost: 0
            });
        }
        if (chainId == AVALANCHE) {
            return Config({
                chainId: chainId,
                settlementChainId: ARBITRUM_ONE,
                cctpDomain: AVALANCHE_DOMAIN,
                isTestnet: false,
                isHomeChain: false,
                cctpFastSupported: false,
                cctpPaymentPlatformFeeCapBps: 100,
                entryPoint: ENTRY_POINT_V09,
                usdc: 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E,
                tokenMessenger: MAINNET_TOKEN_MESSENGER,
                entryPointCodehash: 0x0922f3c2f22b7ca40cbe5941d15cafa91510edd3c493394e802da60a12f1fe3f,
                usdcCodehash: 0x7140a935aa3bb55d334d6d325fea277e47674770b10823feefa6f8b2c58af5fc,
                tokenMessengerCodehash: TOKEN_MESSENGER_CODEHASH,
                create2DeployerCodehash: CREATE2_DEPLOYER_CODEHASH,
                paymasterStake: 0,
                paymasterUnstakeDelay: 0,
                paymasterDeposit: 0,
                maxSponsoredGasCost: 0
            });
        }

        revert NetworkDeploymentConfig__UnsupportedChain(chainId);
    }

    function outboundDomains(Config memory config) internal pure returns (uint32[] memory domains) {
        if (config.isHomeChain) {
            domains = new uint32[](2);
            domains[0] = AVALANCHE_DOMAIN;
            domains[1] = BASE_DOMAIN;
            return domains;
        }
        if (!config.isTestnet) revert NetworkDeploymentConfig__NotHomeChain(config.chainId);
        domains = new uint32[](1);
        domains[0] = ARBITRUM_DOMAIN;
    }

    function requireHomeChain(Config memory config) internal pure {
        if (!config.isHomeChain) revert NetworkDeploymentConfig__NotHomeChain(config.chainId);
    }

    /// @notice Satellite wallet rails may sponsor testnet UserOperations, but a
    ///         mainnet satellite paymaster requires a separate production
    ///         decision and deployment review.
    function requirePaymasterChain(Config memory config) internal pure {
        if (!config.isHomeChain && !config.isTestnet) {
            revert NetworkDeploymentConfig__NotHomeChain(config.chainId);
        }
    }

    /// @notice Phase 4A permits a reviewed satellite CCTP egress router only on
    ///         testnet. Mainnet satellite routing remains a separate release.
    function requireCrosschainRouterChain(Config memory config) internal pure {
        if (!config.isHomeChain && !config.isTestnet) {
            revert NetworkDeploymentConfig__NotHomeChain(config.chainId);
        }
    }

    function requireInboundSourceChain(Config memory config) internal pure {
        if (config.isHomeChain) {
            revert NetworkDeploymentConfig__HomeChainCannotUseInboundRouter(config.chainId);
        }
    }

    function preflightAccounts(Config memory config) internal view {
        _validateCodehash("create2Deployer", CREATE2_DEPLOYER, config.create2DeployerCodehash);
        _validateCodehash("entryPoint", config.entryPoint, config.entryPointCodehash);
    }

    function preflightLocalCheckout(Config memory config) internal view {
        requireHomeChain(config);
        _validateCodehash("create2Deployer", CREATE2_DEPLOYER, config.create2DeployerCodehash);
        _validateCodehash("usdc", config.usdc, config.usdcCodehash);
    }

    function preflightCctp(Config memory config) internal view {
        _validateCodehash("create2Deployer", CREATE2_DEPLOYER, config.create2DeployerCodehash);
        _validateCodehash("usdc", config.usdc, config.usdcCodehash);
        _validateCodehash("tokenMessenger", config.tokenMessenger, config.tokenMessengerCodehash);
    }

    function _validateCodehash(bytes32 component, address target, bytes32 expected) private view {
        bytes32 actual = target.codehash;
        if (actual != expected) {
            revert NetworkDeploymentConfig__CodehashMismatch(component, target, expected, actual);
        }
    }
}
