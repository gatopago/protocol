// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

interface IAccountFactoryDeployment {
    function IMPLEMENTATION() external view returns (address);
}

interface IAccountDeployment {
    function entryPoint() external view returns (address);
}

interface IPaymasterDeployment {
    function ENTRY_POINT() external view returns (address);
}

interface IPaymentRouterDeployment {
    function supportedTokens(address token) external view returns (bool);
}

interface IERC20Deployment {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ICrosschainRouterDeployment {
    function USDC() external view returns (address);
    function TOKEN_MESSENGER() external view returns (address);
    // forge-lint: disable-next-line(mixed-case-function)
    function bridgeUSDC(
        bytes32 opId,
        uint256 amount,
        uint256 fee,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface IAavePoolDeployment {
    function ADDRESSES_PROVIDER() external view returns (address);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IATokenDeployment {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

/**
 *  Live deployment smoke test. Unit runs skip it unless the RPC variable is set.
 */
contract ArbitrumSepoliaForkTest is Test {
    address private constant ENTRY_POINT = 0x433709009B8330FDa32311DF1C2AFA402eD8D009;
    address private constant FACTORY = 0xb97E923E27CB258012081446e4b436afd3974108;
    address private constant PAYMASTER = 0x913a1B51c4f5b1a458A56D0d700c956834cc1d15;
    address private constant VERIFIER = 0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886;
    address private constant PAYMENT_ROUTER = 0xaF5a6856F65eab6bd8d0e403E4cFd49aD0c0c04f;
    address private constant CROSSCHAIN_ROUTER = 0x88Ae8A42d004934cD72b534bd362A49e7E4ad3a1;
    address private constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address private constant CCTP_TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address private constant CCTP_MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address private constant UNIVERSAL_ROUTER = 0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47;
    address private constant AAVE_POOL = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address private constant A_USDC = 0x460b97BD498E1157530AEb3086301d5225b91216;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        vm.skip(bytes(rpcUrl).length == 0, "set ARBITRUM_SEPOLIA_RPC_URL to run fork smoke tests");
        vm.createSelectFork(rpcUrl);
    }

    function test_deploymentsAndExternalIntegrationsAreWired() public view {
        assertEq(block.chainid, 421614);

        address[] memory deployments = new address[](11);
        deployments[0] = ENTRY_POINT;
        deployments[1] = FACTORY;
        deployments[2] = PAYMASTER;
        deployments[3] = VERIFIER;
        deployments[4] = PAYMENT_ROUTER;
        deployments[5] = CROSSCHAIN_ROUTER;
        deployments[6] = USDC;
        deployments[7] = CCTP_TOKEN_MESSENGER;
        deployments[8] = CCTP_MESSAGE_TRANSMITTER;
        deployments[9] = UNIVERSAL_ROUTER;
        deployments[10] = AAVE_POOL;
        for (uint256 i = 0; i < deployments.length; ++i) {
            assertGt(deployments[i].code.length, 0, "configured deployment has no bytecode");
        }

        address implementation = IAccountFactoryDeployment(FACTORY).IMPLEMENTATION();
        assertGt(implementation.code.length, 0, "factory implementation has no bytecode");
        assertEq(IAccountDeployment(implementation).entryPoint(), ENTRY_POINT);
        assertEq(IPaymasterDeployment(PAYMASTER).ENTRY_POINT(), ENTRY_POINT);
        assertTrue(IPaymentRouterDeployment(PAYMENT_ROUTER).supportedTokens(USDC));
        assertEq(ICrosschainRouterDeployment(CROSSCHAIN_ROUTER).USDC(), USDC);
        assertEq(ICrosschainRouterDeployment(CROSSCHAIN_ROUTER).TOKEN_MESSENGER(), CCTP_TOKEN_MESSENGER);

        assertGt(IAavePoolDeployment(AAVE_POOL).ADDRESSES_PROVIDER().code.length, 0);
        assertGt(A_USDC.code.length, 0);
        assertEq(IATokenDeployment(A_USDC).UNDERLYING_ASSET_ADDRESS(), USDC);
    }

    function test_aaveSupplyAndWithdrawRoundTrip() public {
        uint256 amount = 1_000_000;
        deal(USDC, address(this), amount);
        IERC20Deployment(USDC).approve(AAVE_POOL, amount);

        IAavePoolDeployment(AAVE_POOL).supply(USDC, amount, address(this), 0);
        assertGe(IERC20Deployment(A_USDC).balanceOf(address(this)), amount);

        uint256 withdrawn = IAavePoolDeployment(AAVE_POOL).withdraw(USDC, type(uint256).max, address(this));
        assertGe(withdrawn, amount);
        assertGe(IERC20Deployment(USDC).balanceOf(address(this)), amount);
    }

    function test_crosschainRouterBurnsThroughLiveCctp() public {
        uint256 amount = 1_000_000;
        deal(USDC, address(this), amount);
        IERC20Deployment(USDC).approve(CROSSCHAIN_ROUTER, amount);

        ICrosschainRouterDeployment(CROSSCHAIN_ROUTER)
            .bridgeUSDC(keccak256("fork-smoke"), amount, 0, 6, bytes32(uint256(uint160(address(this)))), 0, 2000);

        assertEq(IERC20Deployment(USDC).balanceOf(address(this)), 0);
        assertEq(IERC20Deployment(USDC).balanceOf(CROSSCHAIN_ROUTER), 0);
    }
}
